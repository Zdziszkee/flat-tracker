import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import osmPbf, { type OsmItem } from "osm-pbf-parser";
import RBush from "rbush";

import { db } from "#/db/index";
import { TRACKED_REGIONS, type TrackedRegion } from "#/db/region";
import { osmBuildings } from "#/db/schema";

/**
 * Local OSM building index for every tracked region (małopolskie + śląskie).
 *
 * The public Overpass API is too rate-limited for assigning ~84k RCN
 * transactions to buildings, so this module downloads one Geofabrik
 * extract per tracked voivodeship, streams each PBF with osm-pbf-parser,
 * keeps every building footprint, and stores them in the `osm_buildings`
 * table in a single indexing pass. Matching is then a local
 * point-in-polygon query via an in-memory RBush, with zero network
 * dependency.
 *
 * Regions are indexed per file and concatenated: Geofabrik extracts carry
 * complete ways and relations at their boundaries, so a building that
 * straddles the małopolskie/śląskie border has all of its nodes in both
 * extracts, and OSM ids are global, so the two files cannot collide. Peak
 * memory stays one extract's worth because each file's node/way maps are
 * discarded before the next one starts.
 *
 * Region-wide coverage matters for sources that span the whole voivodeship
 * (booking, airbnb: Zakopane, Oświęcim, Szczawnica...). Cross-town street
 * name collisions are handled downstream: address matching is guarded by
 * city hints (address-index.ts) and, for georeferenced records, by a
 * max-distance check against the record's own coordinates.
 */

const DATA_DIR = "data/osm";

/**
 * One Geofabrik extract per tracked voivodeship. The keys are the source of
 * truth for "which regions is the index built from" (the build marker
 * below), and they mirror `TRACKED_REGIONS` — a region added there without
 * a PBF here means its parcels/building history can never be anchored, so
 * `buildOsmIndex` says so instead of silently indexing less.
 */
export const OSM_REGIONS = ["malopolskie", "slaskie"] as const;
export type OsmRegion = (typeof OSM_REGIONS)[number];

const GEOFABRIK_BASE = "https://download.geofabrik.de/europe/poland";

const PBF_SOURCES: Array<{ region: OsmRegion; url: string; path: string }> =
	OSM_REGIONS.map((region) => ({
		region,
		url: `${GEOFABRIK_BASE}/${region}-latest.osm.pbf`,
		path: `${DATA_DIR}/${region}.osm.pbf`,
	}));

/**
 * Which regions the rows in `osm_buildings` were built from. Adding a
 * region must rebuild the table (it is a full rebuild, not a merge), and
 * the table itself cannot say what built it, so the marker does: an index
 * built before this file existed / with fewer regions reports "not ready".
 */
const BUILD_STATE_PATH = `${DATA_DIR}/build-state.json`;

interface OsmBuildState {
	regions: string[];
	builtAt?: string;
}

export interface OsmBuilding {
	osmId: number;
	bboxMinLat: number;
	bboxMinLng: number;
	bboxMaxLat: number;
	bboxMaxLng: number;
	centroidLat: number;
	centroidLng: number;
	polygon: Array<{ lat: number; lng: number }>;
	address: string | null;
	tags: Record<string, string> | null;
}

function centroid(ring: Array<{ lat: number; lng: number }>): {
	lat: number;
	lng: number;
} {
	let lat = 0;
	let lng = 0;
	for (const p of ring) {
		lat += p.lat;
		lng += p.lng;
	}
	return { lat: lat / ring.length, lng: lng / ring.length };
}

function formatAddress(
	tags: Record<string, string> | undefined,
): string | null {
	if (!tags) return null;
	const street = tags["addr:street"];
	const number = tags["addr:housenumber"];
	if (!street && !number) return null;
	return [street, number].filter(Boolean).join(" ");
}

/** Download every extract that is not cached yet (each ~200 MB). */
async function downloadIfMissing(): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true });
	for (const source of PBF_SOURCES) {
		try {
			await stat(source.path);
			console.log(`Using cached ${source.path}`);
			continue;
		} catch {
			// fall through
		}
		console.log(`Downloading ${source.url} ...`);
		const res = await fetch(source.url, {
			signal: AbortSignal.timeout(600_000),
		});
		if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
		await pipeline(
			Readable.fromWeb(res.body as never),
			createWriteStream(source.path),
		);
	}
}

/**
 * Stream one extract, collect every building way, resolve polygons. Called
 * per region, never with two files in flight: the node and way maps below
 * are the memory hogs (~1.5M buildings each).
 */
async function extractBuildingsFromPbf(
	pbfPath: string,
): Promise<OsmBuilding[]> {
	// Pass 1: collect all building ways (id, refs, tags) in the region.
	const ways = new Map<
		number,
		{ refs: number[]; tags: Record<string, string> }
	>();

	await new Promise<void>((resolve, reject) => {
		const osm = osmPbf();
		osm.on("data", (items: OsmItem[]) => {
			for (const item of items) {
				if (item.type !== "way") continue;
				const tags = (item.tags ?? {}) as Record<string, string>;
				if (!tags.building) continue;
				const refs = (item.refs ?? []) as number[];
				if (refs.length < 3) continue;
				ways.set(item.id as number, { refs, tags });
			}
		});
		osm.on("end", resolve);
		osm.on("error", reject);
		createReadStream(pbfPath).pipe(osm);
	});

	console.log(`building ways in ${pbfPath}: ${ways.size}`);

	// Pass 2: collect coordinates for every referenced node. The extract is
	// voivodeship-wide, so no geographic filtering is needed here.
	const nodeCoords = new Map<number, { lat: number; lng: number }>();
	const needed = new Set<number>();
	for (const w of ways.values()) {
		for (const ref of w.refs) {
			needed.add(ref);
		}
	}

	await new Promise<void>((resolve, reject) => {
		const osm = osmPbf();
		osm.on("data", (items: OsmItem[]) => {
			for (const item of items) {
				if (item.type !== "node") continue;
				const id = item.id as number;
				if (!needed.has(id)) continue;
				nodeCoords.set(id, {
					lat: item.lat as number,
					lng: item.lon as number,
				});
			}
		});
		osm.on("end", resolve);
		osm.on("error", reject);
		createReadStream(pbfPath).pipe(osm);
	});

	console.log(`node coords kept in ${pbfPath}: ${nodeCoords.size}`);

	// Build polygons; skip ways with unresolved refs (clipped at extract edge).
	const buildings: OsmBuilding[] = [];
	for (const [osmId, way] of ways) {
		const ring: Array<{ lat: number; lng: number }> = [];
		let complete = true;
		for (const ref of way.refs) {
			const c = nodeCoords.get(ref);
			if (!c) {
				complete = false;
				break;
			}
			ring.push(c);
		}
		if (!complete || ring.length < 3) continue;

		const c = centroid(ring);
		let minLat = Infinity;
		let minLng = Infinity;
		let maxLat = -Infinity;
		let maxLng = -Infinity;
		for (const p of ring) {
			minLat = Math.min(minLat, p.lat);
			minLng = Math.min(minLng, p.lng);
			maxLat = Math.max(maxLat, p.lat);
			maxLng = Math.max(maxLng, p.lng);
		}
		buildings.push({
			osmId,
			bboxMinLat: minLat,
			bboxMinLng: minLng,
			bboxMaxLat: maxLat,
			bboxMaxLng: maxLng,
			centroidLat: c.lat,
			centroidLng: c.lng,
			polygon: ring,
			address: formatAddress(way.tags),
			tags: way.tags,
		});
	}

	console.log(`buildings found in ${pbfPath}: ${buildings.length}`);
	return buildings;
}

/** Write which regions the current `osm_buildings` rows came from. */
async function saveBuildState(builtAt: Date): Promise<void> {
	const state: OsmBuildState = {
		regions: [...OSM_REGIONS],
		builtAt: builtAt.toISOString(),
	};
	await writeFile(BUILD_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Marker of the last `buildOsmIndex` run, or null when there is none (an
 * index built before this marker existed, or on another machine).
 */
async function readBuildState(): Promise<OsmBuildState | null> {
	try {
		return JSON.parse(
			await readFile(BUILD_STATE_PATH, "utf8"),
		) as OsmBuildState;
	} catch {
		return null;
	}
}

/**
 * Download every extract, parse each, and (re)build the whole
 * `osm_buildings` table in one pass. A full rebuild on purpose: the table
 * is a bounded local index, and a region added to `OSM_REGIONS` has to
 * replace the old rows rather than merge with them (deleting by region is
 * impossible — a footprint row does not record which extract it came from).
 */
export async function buildOsmIndex(): Promise<number> {
	await downloadIfMissing();

	const tracked = Object.keys(TRACKED_REGIONS) as TrackedRegion[];
	const missing = tracked.filter(
		(region) => !(OSM_REGIONS as readonly string[]).includes(region),
	);
	if (missing.length > 0) {
		console.warn(
			`[osm] tracked region(s) ${missing.join(", ")} have no Geofabrik extract in OSM_REGIONS; ` +
				"their parcels and transactions can never be anchored to a building",
		);
	}

	const buildings: OsmBuilding[] = [];
	for (const source of PBF_SOURCES) {
		const found = await extractBuildingsFromPbf(source.path);
		console.log(`  ${source.region}: ${found.length} buildings`);
		buildings.push(...found);
	}

	await db.delete(osmBuildings);
	const BATCH = 2000;
	for (let i = 0; i < buildings.length; i += BATCH) {
		const slice = buildings.slice(i, i + BATCH);
		await db.insert(osmBuildings).values(
			slice.map((b) => ({
				osmId: b.osmId,
				bboxMinLat: b.bboxMinLat,
				bboxMinLng: b.bboxMinLng,
				bboxMaxLat: b.bboxMaxLat,
				bboxMaxLng: b.bboxMaxLng,
				centroidLat: b.centroidLat,
				centroidLng: b.centroidLng,
				polygon: JSON.stringify(b.polygon),
				address: b.address,
				tags: b.tags ? JSON.stringify(b.tags) : null,
			})),
		);
	}
	await saveBuildState(new Date());
	console.log(`osm_buildings: ${buildings.length} rows inserted`);
	return buildings.length;
}

interface IndexedBuilding extends OsmBuilding {
	id: number;
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

let cached: RBush<IndexedBuilding> | null = null;

/** Load the local index from the DB (cached in memory for the process). */
export async function loadOsmIndex(): Promise<RBush<IndexedBuilding>> {
	if (cached) return cached;
	const rows = await db.select().from(osmBuildings);
	const tree = new RBush<IndexedBuilding>();
	const items: IndexedBuilding[] = rows.map((r) => ({
		id: r.id,
		osmId: r.osmId,
		bboxMinLat: r.bboxMinLat,
		bboxMinLng: r.bboxMinLng,
		bboxMaxLat: r.bboxMaxLat,
		bboxMaxLng: r.bboxMaxLng,
		centroidLat: r.centroidLat,
		centroidLng: r.centroidLng,
		polygon: JSON.parse(r.polygon) as Array<{ lat: number; lng: number }>,
		address: r.address,
		tags: r.tags ? (JSON.parse(r.tags) as Record<string, string>) : null,
		// RBush expects minX/minY/maxX/maxY (x = lng, y = lat).
		minX: r.bboxMinLng,
		minY: r.bboxMinLat,
		maxX: r.bboxMaxLng,
		maxY: r.bboxMaxLat,
	}));
	tree.load(items);
	cached = tree;
	console.log(`osm index loaded: ${items.length} buildings`);
	return tree;
}

function pointInPolygon(
	lat: number,
	lng: number,
	poly: Array<{ lat: number; lng: number }>,
): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].lng;
		const yi = poly[i].lat;
		const xj = poly[j].lng;
		const yj = poly[j].lat;
		const intersect =
			yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function haversineMeters(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Find the building containing the point; fall back to nearest centroid. */
export function matchPointLocal(
	tree: RBush<IndexedBuilding>,
	lat: number,
	lng: number,
	radiusM = 40,
): IndexedBuilding | null {
	// Query a small square around the point (radiusM ~ 0.0005 deg ≈ 55 m).
	const d = 0.0006;
	const candidates = tree.search({
		minX: lng - d,
		minY: lat - d,
		maxX: lng + d,
		maxY: lat + d,
	});

	// 1. True containment.
	for (const b of candidates) {
		if (pointInPolygon(lat, lng, b.polygon)) return b;
	}
	// 2. Nearest centroid within the radius.
	let best: IndexedBuilding | null = null;
	let bestDist = radiusM;
	for (const b of candidates) {
		const dist = haversineMeters(lat, lng, b.centroidLat, b.centroidLng);
		if (dist < bestDist) {
			bestDist = dist;
			best = b;
		}
	}
	return best;
}

function normStreet(s: string | null): string {
	return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Street-aware matching for RCN transactions. RCN georeferenced points can
 * sit on the plot centroid tens of meters from the building footprint
 * (new developments), so beyond the exact 40 m fallback we accept a
 * building whose addr:street matches the transaction street within
 * `streetRadiusM` (default 150 m). Only used for transactions, whose
 * addresses come from the authoritative notarial records.
 */
export function matchPointStreetAware(
	tree: RBush<IndexedBuilding>,
	lat: number,
	lng: number,
	street: string | null,
	streetRadiusM = 150,
): IndexedBuilding | null {
	// 1-2. Exact containment / 40 m nearest, as before.
	const exact = matchPointLocal(tree, lat, lng, 40);
	if (exact) return exact;

	const d = 0.002; // ~220 m search box
	const candidates = tree.search({
		minX: lng - d,
		minY: lat - d,
		maxX: lng + d,
		maxY: lat + d,
	});

	const streetNorm = normStreet(street);
	let bestStreet: IndexedBuilding | null = null;
	let bestStreetDist = streetRadiusM;
	let bestAny: IndexedBuilding | null = null;
	let bestAnyDist = streetRadiusM;

	for (const b of candidates) {
		const dist = haversineMeters(lat, lng, b.centroidLat, b.centroidLng);
		if (dist >= bestStreetDist && dist >= bestAnyDist) continue;
		const addr = normStreet(b.address);
		if (streetNorm && addr.startsWith(streetNorm) && dist < bestStreetDist) {
			bestStreetDist = dist;
			bestStreet = b;
		}
		if (dist < bestAnyDist) {
			bestAnyDist = dist;
			bestAny = b;
		}
	}
	return bestStreet ?? bestAny;
}

/**
 * True when `osm_buildings` is populated *from the current region set*.
 * The row count alone is not enough: an index built for małopolskie only
 * would happily report ready and leave every śląskie transaction
 * unanchored, so a missing/stale build marker means "rebuild".
 */
export async function osmIndexReady(): Promise<boolean> {
	const rows = await db
		.select({ id: osmBuildings.id })
		.from(osmBuildings)
		.limit(1);
	if (rows.length === 0) return false;

	const state = await readBuildState();
	if (!state) {
		console.log(
			`[osm] no ${BUILD_STATE_PATH} marker; rebuilding the index for ${OSM_REGIONS.join(" + ")}`,
		);
		return false;
	}
	const covered = new Set(state.regions ?? []);
	const missing = OSM_REGIONS.filter((region) => !covered.has(region));
	if (missing.length > 0) {
		console.log(
			`[osm] index was built without ${missing.join(", ")}; rebuilding for ${OSM_REGIONS.join(" + ")}`,
		);
		return false;
	}
	return true;
}
