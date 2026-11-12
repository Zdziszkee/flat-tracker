/**
 * Parcel feature enrichment.
 *
 * For every parcel linked to a listing or transaction, compute the physical
 * features that the valuation model needs and store them in
 * `parcel_features`:
 *
 *   - geometry: area, perimeter, compactness
 *   - buildings: count, footprint area, coverage, max floors
 *   - roads: distance to the nearest public road, road class, frontage
 *   - land: EGiB land-use class and register group
 *   - zoning: WZ flag, no-plan flag, label count
 *
 * Flood and slope are filled by `flood.ts` / `terrain.ts` and left null
 * here when those layers are unavailable. The job is bounded per run and
 * idempotent: a parcel with a `parcel_features` row is skipped.
 */

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";

import { db } from "#/db/index";
import {
	listings,
	osmBuildings,
	osmRoads,
	parcelFeatures,
	parcelMeta,
	parcels,
	transactions,
} from "#/db/schema";
import { parseParcelRing, pointInRing, ringAreaM2 } from "./egib.ts";
import {
	fetchKrakowFloodAtPoint,
	fetchKrakowMpzpAtPoint,
	fetchKrakowPermitsAtPoint,
	fetchKrakowWzAtPoint,
	isKrakowParcel,
} from "./krakow-planning.ts";
import { demReady, terrainAt } from "./terrain.ts";

export interface EnrichParcelsOptions {
	/** Max parcels to process this run. Default 2000. */
	limit?: number;
	/** Recompute rows older than this many days. Default 30. */
	staleDays?: number;
	/** Force these parcel ids (used for a new listing and tests). */
	parcelIds?: string[];
	/** Skip the Krakow MSIP planning/flood calls. */
	includePlanning?: boolean;
	/** Skip the Copernicus DEM reads. */
	includeTerrain?: boolean;
}

export interface EnrichParcelsReport {
	processed: number;
	withBuildings: number;
	withRoad: number;
	withZoning: number;
	missed: number;
}

interface Ring {
	lat: number;
	lng: number;
}

function ringPerimeterM(ring: Ring[]): number {
	if (ring.length < 2) return 0;
	let sum = 0;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		sum += haversineM(a.lat, a.lng, b.lat, b.lng);
	}
	return sum;
}

function haversineM(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6_371_000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Distance from a point to a segment, in metres, via a local projection. */
function pointSegmentM(
	lat: number,
	lng: number,
	a: Ring,
	b: Ring,
): number {
	const lat0 = (lat + a.lat + b.lat) / 3;
	const mx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
	const my = 110_574;
	const px = (lng - a.lng) * mx;
	const py = (lat - a.lat) * my;
	const bx = (b.lng - a.lng) * mx;
	const by = (b.lat - a.lat) * my;
	const len2 = bx * bx + by * by;
	if (len2 === 0) return Math.hypot(px, py);
	const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
	return Math.hypot(px - t * bx, py - t * by);
}

/** Min distance from a point to a polyline. */
function pointPolylineM(point: Ring, line: Ring[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < line.length - 1; i++) {
		const d = pointSegmentM(point.lat, point.lng, line[i], line[i + 1]);
		if (d < best) best = d;
	}
	return best;
}

/** Min distance from any vertex of one polygon to another polyline. */
function ringPolylineM(ring: Ring[], line: Ring[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (const p of ring) {
		const d = pointPolylineM(p, line);
		if (d < best) best = d;
	}
	return best;
}

interface RoadHit {
	distanceM: number;
	roadClass: string;
	frontageM: number;
}

function roadMetrics(ring: Ring[], roads: Array<{ roadClass: string; points: Ring[] }>): RoadHit {
	let best = Number.POSITIVE_INFINITY;
	let bestClass = "";
	let frontage = 0;
	for (const road of roads) {
		const d = ringPolylineM(ring, road.points);
		if (d < best) {
			best = d;
			bestClass = road.roadClass;
		}
		if (d <= 10) {
			// Approximate frontage: parcel edges whose midpoint is within
			// 10 m of this road. Good enough for a model feature, and it
			// avoids a full polygon buffer implementation.
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i];
				const b = ring[(i + 1) % ring.length];
				const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
				if (pointPolylineM(mid, road.points) <= 10) {
					frontage += haversineM(a.lat, a.lng, b.lat, b.lng);
				}
			}
		}
	}
	if (!Number.isFinite(best)) {
		return { distanceM: Number.NaN, roadClass: "", frontageM: 0 };
	}
	return { distanceM: best, roadClass: bestClass, frontageM: frontage };
}

interface BuildingStats {
	count: number;
	areaM2: number;
	maxFloors: number | null;
	subtype: string | null;
	residentialRatio: number | null;
	garageRatio: number | null;
	commercialRatio: number | null;
}

type BuildingClass = "residential" | "garage" | "commercial" | "other";

const RESIDENTIAL_TAGS = new Set([
	"house",
	"apartments",
	"residential",
	"detached",
	"semidetached_house",
	"terrace",
	"bungalow",
	"farm",
	"cabin",
	"static_caravan",
	"dormitory",
]);
const GARAGE_TAGS = new Set([
	"garage",
	"garages",
	"shed",
	"hut",
	"carport",
	"greenhouse",
	"barn",
	"stable",
	"cowshed",
]);
const COMMERCIAL_TAGS = new Set([
	"commercial",
	"industrial",
	"warehouse",
	"retail",
	"office",
	"kiosk",
	"supermarket",
	"hotel",
	"school",
	"hospital",
	"church",
	"public",
	"civic",
	"government",
]);

function classifyBuilding(tag: string | undefined): BuildingClass {
	if (!tag) return "other";
	const t = tag.toLowerCase();
	if (RESIDENTIAL_TAGS.has(t)) return "residential";
	if (GARAGE_TAGS.has(t)) return "garage";
	if (COMMERCIAL_TAGS.has(t)) return "commercial";
	return "other";
}

function buildingStats(
	ring: Ring[],
	candidates: Array<{ polygon: string; tags: string | null }>,
): BuildingStats {
	let count = 0;
	let area = 0;
	let maxFloors: number | null = null;
	const areaByClass: Record<BuildingClass, number> = {
		residential: 0,
		garage: 0,
		commercial: 0,
		other: 0,
	};
	for (const b of candidates) {
		let bRing: Ring[];
		try {
			bRing = JSON.parse(b.polygon) as Ring[];
		} catch {
			continue;
		}
		if (bRing.length < 3) continue;
		const inside = bRing.some((p) => pointInRing(ring, p.lat, p.lng));
		if (!inside) continue;
		count++;
		const footprint = ringAreaM2(bRing);
		area += footprint;
		let buildingTag: string | undefined;
		if (b.tags) {
			try {
				const tags = JSON.parse(b.tags) as Record<string, string>;
				buildingTag = tags.building;
				const levels = Number.parseFloat(
					tags["building:levels"] ?? tags.levels ?? "",
				);
				if (Number.isFinite(levels) && levels > 0) {
					maxFloors = Math.max(maxFloors ?? 0, levels);
				}
			} catch {
				// ignore malformed tags
			}
		}
		areaByClass[classifyBuilding(buildingTag)] += footprint;
	}
	if (count === 0 || area <= 0) {
		return {
			count,
			areaM2: area,
			maxFloors,
			subtype: null,
			residentialRatio: null,
			garageRatio: null,
			commercialRatio: null,
		};
	}
	const dominant = (
		Object.entries(areaByClass) as Array<[BuildingClass, number]>
	).sort((a, b) => b[1] - a[1])[0][0];
	return {
		count,
		areaM2: area,
		maxFloors,
		subtype: dominant,
		residentialRatio: areaByClass.residential / area,
		garageRatio: areaByClass.garage / area,
		commercialRatio: areaByClass.commercial / area,
	};
}

function zoningOf(zoning: string | null): {
	wz: boolean;
	noPlan: boolean;
	count: number;
	flags: string[];
} {
	if (!zoning) return { wz: false, noPlan: false, count: 0, flags: [] };
	const flags = zoning
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		wz: flags.includes("decyzjaWarunkiZabudowy"),
		noPlan: flags.includes("brakMPZPLubWZ"),
		count: flags.length,
		flags,
	};
}

export async function enrichParcels(
	options: EnrichParcelsOptions = {},
): Promise<EnrichParcelsReport> {
	const limit = options.limit ?? 2000;
	const staleDays = options.staleDays ?? 30;
	const staleCutoff = Math.floor(Date.now() / 1000) - staleDays * 86_400;
	const includePlanning = options.includePlanning !== false;
	const hasDem = options.includeTerrain !== false && (await demReady());

	// Parcels that are actually used by a listing or transaction and have no
	// feature row yet (or a stale one). The union is indexed on both sides.
	const forced = options.parcelIds?.map((parcel_id) => ({ parcel_id })) ?? [];
	const candidates =
		forced.length > 0
			? forced
			: ((await db.all(sql`
				select linked.parcel_id
				from (
					select distinct parcel_id from ${listings} where parcel_id is not null
					union
					select distinct parcel_id from ${transactions} where parcel_id is not null
				) linked
				join ${parcels} p on p.parcelId = linked.parcel_id
				where linked.parcel_id not in (
					select parcel_id from ${parcelFeatures} where updated_at >= ${staleCutoff}
				)
				limit ${limit}
			`)) as Array<{ parcel_id: string }>);

	const report: EnrichParcelsReport = {
		processed: 0,
		withBuildings: 0,
		withRoad: 0,
		withZoning: 0,
		missed: 0,
	};

	for (const { parcel_id: parcelId } of candidates) {
		const [parcel] = await db
			.select({
				polygon: parcels.polygon,
				landUseClass: parcels.landUseClass,
				registerGroup: parcels.registerGroup,
				bboxMinLat: parcels.bboxMinLat,
				bboxMinLng: parcels.bboxMinLng,
				bboxMaxLat: parcels.bboxMaxLat,
				bboxMaxLng: parcels.bboxMaxLng,
				egibDataDate: parcels.egibDataDate,
			})
			.from(parcels)
			.where(eq(parcels.parcelId, parcelId))
			.limit(1);
		if (!parcel) {
			report.missed++;
			continue;
		}
		const ring: Ring[] = parseParcelRing(parcel.polygon);
		if (ring.length < 3) {
			report.missed++;
			continue;
		}

		const areaM2 = ringAreaM2(ring);
		const perimeterM = ringPerimeterM(ring);
		const compactness =
			perimeterM > 0 ? (4 * Math.PI * areaM2) / (perimeterM * perimeterM) : null;

		const buildingRows = await db
			.select({ polygon: osmBuildings.polygon, tags: osmBuildings.tags })
			.from(osmBuildings)
			.where(
				and(
					lte(osmBuildings.bboxMinLat, parcel.bboxMaxLat),
					gte(osmBuildings.bboxMaxLat, parcel.bboxMinLat),
					lte(osmBuildings.bboxMinLng, parcel.bboxMaxLng),
					gte(osmBuildings.bboxMaxLng, parcel.bboxMinLng),
				),
			);
		const bStats = buildingStats(ring, buildingRows);

		const pad = 0.0006; // ~60 m
		const roadRows = await db
			.select({ roadClass: osmRoads.roadClass, points: osmRoads.points })
			.from(osmRoads)
			.where(
				and(
					lte(osmRoads.bboxMinLat, parcel.bboxMaxLat + pad),
					gte(osmRoads.bboxMaxLat, parcel.bboxMinLat - pad),
					lte(osmRoads.bboxMinLng, parcel.bboxMaxLng + pad),
					gte(osmRoads.bboxMaxLng, parcel.bboxMinLng - pad),
				),
			);
		const roads = roadRows
			.map((r) => {
				try {
					return {
						roadClass: r.roadClass,
						points: JSON.parse(r.points) as Ring[],
					};
				} catch {
					return null;
				}
			})
			.filter((r): r is { roadClass: string; points: Ring[] } => r !== null);
		const rStats = roadMetrics(ring, roads);

		let latSum = 0;
		let lngSum = 0;
		for (const p of ring) {
			latSum += p.lat;
			lngSum += p.lng;
		}
		const centroidLat = latSum / ring.length;
		const centroidLng = lngSum / ring.length;
		const terrain = hasDem
			? await terrainAt(centroidLat, centroidLng)
			: { elevationM: null, slopeDeg: null };

		let zoning: {
			wz: boolean;
			noPlan: boolean;
			count: number;
			flags: string[];
		};
		let zoningDetail: unknown = null;
		let floodRisk: boolean | null = null;
		let sourceDataDate = parcel.egibDataDate;
		if (isKrakowParcel(parcelId) && includePlanning) {
			const [mpzp, wz, flood, permits] = await Promise.all([
				fetchKrakowMpzpAtPoint(centroidLat, centroidLng).catch(() => []),
				fetchKrakowWzAtPoint(centroidLat, centroidLng).catch(() => []),
				fetchKrakowFloodAtPoint(centroidLat, centroidLng).catch(() => ({
					flood: false,
					layer: null,
				})),
				fetchKrakowPermitsAtPoint(centroidLat, centroidLng).catch(() => []),
			]);
			const labels = mpzp.map((z) =>
				["MPZP", z.nazwa, z.oznaczenie].filter(Boolean).join(" "),
			);
			const wzLabels = wz.map((w) =>
				["WZ", w.rodzaj, w.dataDecyzji].filter(Boolean).join(" "),
			);
			const flags = [...labels, ...wzLabels];
			const wzPositive = wz.some((w) =>
				(w.rodzaj ?? "").toLowerCase().includes("pozytywn"),
			);
			zoning = {
				wz: wzPositive,
				noPlan: mpzp.length === 0 && !wzPositive,
				count: mpzp.length + wz.length,
				flags,
			};
			zoningDetail = { labels: flags, mpzp, wz, permits };
			floodRisk = flood.flood;
			sourceDataDate = new Date().toISOString().slice(0, 10);
		} else {
			const [meta] = await db
				.select({ zoning: parcelMeta.zoning })
				.from(parcelMeta)
				.where(eq(parcelMeta.parcelId, parcelId))
				.limit(1);
			zoning = zoningOf(meta?.zoning ?? null);
		}

		await db
			.insert(parcelFeatures)
			.values({
				parcelId,
				areaM2,
				perimeterM,
				compactness,
				frontageM: rStats.frontageM,
				roadDistanceM: Number.isFinite(rStats.distanceM)
					? rStats.distanceM
					: null,
				roadClass: rStats.roadClass || null,
				buildingCount: bStats.count,
				buildingAreaM2: bStats.areaM2,
				buildingSubtype: bStats.subtype,
				buildingResidentialRatio: bStats.residentialRatio,
				buildingGarageRatio: bStats.garageRatio,
				buildingCommercialRatio: bStats.commercialRatio,
				buildingCoverage:
					areaM2 > 0 ? Math.min(1, bStats.areaM2 / areaM2) : null,
				maxFloors: bStats.maxFloors,
				landUseClass: parcel.landUseClass,
				registerGroup: parcel.registerGroup,
				zoningWz: zoning.wz,
				zoningNoPlan: zoning.noPlan,
				zoningPlanCount: zoning.count,
				zoningFlags: JSON.stringify(zoningDetail ?? zoning.flags),
				floodRisk,
				slopeDeg: terrain.slopeDeg,
				elevationM: terrain.elevationM,
				sourceDataDate,
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: parcelFeatures.parcelId,
				set: {
					areaM2,
					perimeterM,
					compactness,
					frontageM: rStats.frontageM,
					roadDistanceM: Number.isFinite(rStats.distanceM)
						? rStats.distanceM
						: null,
					roadClass: rStats.roadClass || null,
					buildingCount: bStats.count,
					buildingAreaM2: bStats.areaM2,
					buildingSubtype: bStats.subtype,
					buildingResidentialRatio: bStats.residentialRatio,
					buildingGarageRatio: bStats.garageRatio,
					buildingCommercialRatio: bStats.commercialRatio,
					buildingCoverage:
						areaM2 > 0 ? Math.min(1, bStats.areaM2 / areaM2) : null,
					maxFloors: bStats.maxFloors,
					landUseClass: parcel.landUseClass,
					registerGroup: parcel.registerGroup,
					zoningWz: zoning.wz,
					zoningNoPlan: zoning.noPlan,
					zoningPlanCount: zoning.count,
					zoningFlags: JSON.stringify(zoningDetail ?? zoning.flags),
					floodRisk,
					slopeDeg: terrain.slopeDeg,
					elevationM: terrain.elevationM,
					sourceDataDate,
					updatedAt: new Date(),
				},
			});

		report.processed++;
		if (bStats.count > 0) report.withBuildings++;
		if (Number.isFinite(rStats.distanceM)) report.withRoad++;
		if (zoning.count > 0) report.withZoning++;
	}

	return report;
}

/** CLI alias for `bun run enrich:parcels`. */
async function main(): Promise<void> {
	const idsArg = process.argv.find((a) => a.startsWith("--ids="));
	const chunkArg = process.argv.find((a) => a.startsWith("--chunk="));
	const fast = process.argv.includes("--fast");
	if (idsArg) {
		const path = idsArg.slice("--ids=".length);
		const chunk = chunkArg ? Number.parseInt(chunkArg.split("=")[1], 10) : 100;
		const ids = [
			...new Set(
				readFileSync(path, "utf8")
					.split(/\s+/)
					.map((s) => s.trim())
					.filter(Boolean),
			),
		];
		console.log(`enrich-parcels: ${ids.length} ids from ${path}, chunk ${chunk}`);
		let processed = 0;
		for (let i = 0; i < ids.length; i += chunk) {
			const part = ids.slice(i, i + chunk);
			const report = await enrichParcels({
				parcelIds: part,
				staleDays: 0,
				includePlanning: !fast,
				includeTerrain: !fast,
			});
			processed += report.processed;
			console.log(
				`JCODE_PROGRESS ${JSON.stringify({
					percent: Math.round(((i + part.length) / ids.length) * 100),
					current: i + part.length,
					total: ids.length,
					unit: "parcels",
					message: `${processed} processed, ${report.missed} missed`,
				})}`,
			);
		}
		console.log(`enrich-parcels done: ${processed} processed`);
		return;
	}
	const report = await enrichParcels({ limit: 20_000 });
	console.log(
		`enrich-parcels: ${report.processed} processed, ` +
			`${report.withBuildings} with buildings, ${report.withRoad} with road, ` +
			`${report.withZoning} with zoning, ${report.missed} missed`,
	);
}

if (
	process.argv[1]?.replace(/\\/g, "/").endsWith("/src/crawler/enrich-parcels.ts")
) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
