import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, osmBuildings, transactions } from "#/db/schema";

/**
 * Click-to-inspect for the 3D buildings layer: given a clicked point,
 * find the building (point-in-polygon over our buildings table, with a
 * nearest-centroid fallback) and return its RCN transaction history.
 *
 * The price history comes from the same Rejestr Cen Nieruchomości data
 * that portals like deweloperuch.pl aggregate, imported locally by the
 * refresh pipeline (see src/crawler/import-rcn.ts).
 */

interface CachedBuilding {
	id: number;
	osmId: number;
	address: string | null;
	lat: number;
	lng: number;
	polygon: Array<{ lat: number; lng: number }> | null;
}

let cache: CachedBuilding[] | null = null;

interface OsmBuildingLight {
	osmId: number;
	address: string | null;
	lat: number;
	lng: number;
}

let osmCache: OsmBuildingLight[] | null = null;

async function getOsmBuildingsCache(): Promise<OsmBuildingLight[]> {
	if (osmCache) return osmCache;
	const rows = await db
		.select({
			osmId: osmBuildings.osmId,
			address: osmBuildings.address,
			centroidLat: osmBuildings.centroidLat,
			centroidLng: osmBuildings.centroidLng,
		})
		.from(osmBuildings);
	osmCache = rows.map((r) => ({
		osmId: r.osmId,
		address: r.address,
		lat: r.centroidLat,
		lng: r.centroidLng,
	}));
	return osmCache;
}

/** Nearest osm_buildings centroid within 25 m (address-only fallback). */
function findNearestOsm(
	rows: OsmBuildingLight[],
	lat: number,
	lng: number,
): OsmBuildingLight | null {
	let best: OsmBuildingLight | null = null;
	let bestDist = 25;
	for (const b of rows) {
		const d = haversineMeters(lat, lng, b.lat, b.lng);
		if (d < bestDist) {
			bestDist = d;
			best = b;
		}
	}
	return best;
}

/** Reverse-geocode a point via Nominatim (street-level address). */
async function reverseGeocode(
	lat: number,
	lng: number,
): Promise<string | null> {
	const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18`;
	try {
		const res = await fetch(url, {
			headers: {
				"user-agent": "flat-tracker/0.1 (personal project)",
				accept: "application/json",
			},
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const j = (await res.json()) as { address?: Record<string, string> };
		const a = j.address ?? {};
		const street = a.road ?? a.pedestrian ?? a.footway ?? a.cycleway ?? null;
		const number = a.house_number ?? null;
		if (!street) return null;
		return number ? `${street} ${number}` : street;
	} catch {
		return null;
	}
}

/** Reverse-geocode with a small in-memory cache (1 per building per run). */
const reverseCache = new Map<string, string | null>();
async function reverseGeocodeCached(
	lat: number,
	lng: number,
): Promise<string | null> {
	const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
	if (reverseCache.has(key)) return reverseCache.get(key) ?? null;
	const addr = await reverseGeocode(lat, lng);
	reverseCache.set(key, addr);
	return addr;
}

async function getBuildingsCache(): Promise<CachedBuilding[]> {
	if (cache) return cache;
	const rows = await db.select().from(buildings);
	cache = rows.map((r) => ({
		id: r.id,
		osmId: r.osmId,
		address: r.address,
		lat: r.lat,
		lng: r.lng,
		polygon: r.geometry
			? (JSON.parse(r.geometry) as Array<{ lat: number; lng: number }>)
			: null,
	}));
	return cache;
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
	lng1: number,
	lat2: number,
	lng2: number,
): number {
	const R = 6371000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** True containment first, then nearest centroid within 30 m. */
function findBuildingAt(
	rows: CachedBuilding[],
	lat: number,
	lng: number,
): CachedBuilding | null {
	for (const b of rows) {
		if (
			b.polygon &&
			b.polygon.length > 2 &&
			pointInPolygon(lat, lng, b.polygon)
		) {
			return b;
		}
	}
	let best: CachedBuilding | null = null;
	let bestDist = 30;
	for (const b of rows) {
		const d = haversineMeters(lat, lng, b.lat, b.lng);
		if (d < bestDist) {
			bestDist = d;
			best = b;
		}
	}
	return best;
}

interface BuildingStats {
	txCount: number;
	avgPricePerM2: number | null;
	minPricePerM2: number | null;
	maxPricePerM2: number | null;
	minPrice: number | null;
	maxPrice: number | null;
	minDate: string | null;
	maxDate: string | null;
	byYear: Array<{ year: string; count: number; avgPricePerM2: number | null }>;
	recent: Array<{
		date: string;
		price: number;
		pricePerM2: number | null;
		areaM2: number | null;
		rooms: number | null;
		street: string | null;
		streetNumber: string | null;
		district: string | null;
	}>;
}

async function buildingStats(buildingId: number): Promise<BuildingStats> {
	const [agg] = await db
		.select({
			txCount: sql<number>`count(*)`,
			avgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
			minPricePerM2: sql<number | null>`min(${transactions.pricePerM2})`,
			maxPricePerM2: sql<number | null>`max(${transactions.pricePerM2})`,
			minPrice: sql<number | null>`min(${transactions.price})`,
			maxPrice: sql<number | null>`max(${transactions.price})`,
			minDate: sql<
				string | null
			>`strftime('%Y-%m-%d', min(${transactions.date}), 'unixepoch')`,
			maxDate: sql<
				string | null
			>`strftime('%Y-%m-%d', max(${transactions.date}), 'unixepoch')`,
		})
		.from(transactions)
		.where(eq(transactions.buildingId, buildingId));

	const byYear = await db
		.select({
			year: sql<string>`strftime('%Y', ${transactions.date}, 'unixepoch')`,
			count: sql<number>`count(*)`,
			avgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
		})
		.from(transactions)
		.where(eq(transactions.buildingId, buildingId))
		.groupBy(sql`strftime('%Y', ${transactions.date}, 'unixepoch')`)
		.orderBy(sql`1`);

	const recent = await db
		.select({
			date: sql<string>`strftime('%Y-%m-%d', ${transactions.date}, 'unixepoch')`,
			price: transactions.price,
			pricePerM2: transactions.pricePerM2,
			areaM2: transactions.areaM2,
			rooms: transactions.rooms,
			street: transactions.street,
			streetNumber: transactions.streetNumber,
			district: transactions.district,
		})
		.from(transactions)
		.where(eq(transactions.buildingId, buildingId))
		.orderBy(desc(transactions.date))
		.limit(5);

	return {
		txCount: agg?.txCount ?? 0,
		avgPricePerM2: agg?.avgPricePerM2 ?? null,
		minPricePerM2: agg?.minPricePerM2 ?? null,
		maxPricePerM2: agg?.maxPricePerM2 ?? null,
		minPrice: agg?.minPrice ?? null,
		maxPrice: agg?.maxPrice ?? null,
		minDate: agg?.minDate ?? null,
		maxDate: agg?.maxDate ?? null,
		byYear,
		recent,
	};
}

export const Route = createFileRoute("/api/buildings/lookup")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const lat = Number(url.searchParams.get("lat"));
				const lng = Number(url.searchParams.get("lng"));
				const osmIdParam = url.searchParams.get("osmId");

				// Exact OSM id match (from the clicked composite feature) is
				// the most reliable; coordinates are a fallback.
				if (osmIdParam) {
					const osmId = Number(osmIdParam);
					if (Number.isFinite(osmId)) {
						const rows = await getBuildingsCache();
						const b = rows.find((r) => r.osmId === osmId);
						if (b) {
							const stats = await buildingStats(b.id);
							return json({
								building: {
									id: b.id,
									osmId: b.osmId,
									address: b.address,
									lat: b.lat,
									lng: b.lng,
									stats,
								},
							});
						}
						// Fallback: address-only from osm_buildings.
						const osmRows = await getOsmBuildingsCache();
						const osm = osmRows.find((r) => r.osmId === osmId);
						if (osm) {
							const address =
								osm.address ?? (await reverseGeocodeCached(osm.lat, osm.lng));
							return json({
								building: {
									id: null,
									osmId: osm.osmId,
									address,
									lat: osm.lat,
									lng: osm.lng,
									stats: null,
								},
							});
						}
					}
				}

				if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
					return json({ building: null });
				}
				const rows = await getBuildingsCache();
				const building = findBuildingAt(rows, lat, lng);

				// Building in our RCN-anchored table: full stats.
				if (building) {
					const stats = await buildingStats(building.id);
					return json({
						building: {
							id: building.id,
							osmId: building.osmId,
							address: building.address,
							lat: building.lat,
							lng: building.lng,
							stats,
						},
					});
				}

				// Fallback: any Krakow building (osm_buildings) so the
				// address is always shown, even without RCN history.
				const osmRows = await getOsmBuildingsCache();
				const osm = findNearestOsm(osmRows, lat, lng);
				if (osm) {
					const address =
						osm.address ?? (await reverseGeocodeCached(osm.lat, osm.lng));
					return json({
						building: {
							id: null,
							osmId: osm.osmId,
							address,
							lat: osm.lat,
							lng: osm.lng,
							stats: null,
						},
					});
				}

				return json({ building: null });
			},
		},
	},
});
