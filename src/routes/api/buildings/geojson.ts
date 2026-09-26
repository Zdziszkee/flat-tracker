import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { count, isNotNull } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, transactions } from "#/db/schema";

/**
 * GeoJSON of buildings that HAVE RCN price history (from the local
 * buildings table), used by the map as an amber overlay on top of
 * Mapbox's composite 3D buildings (which covers ALL Krakow footprints).
 * Only history-bearing buildings are sent, so the payload stays small.
 */

interface CachedFeature {
	id: number;
	osmId: number;
	address: string | null;
	txCount: number;
	/** Estimated building height in meters, for the 3D extrusion. */
	height: number;
	geometry: { type: "Polygon"; coordinates: number[][][] };
}

/** Height from OSM height tag, else building:levels * 3 m, else 12 m. */
function buildingHeight(tagsJson: string | null): number {
	if (!tagsJson) return 12;
	try {
		const t = JSON.parse(tagsJson) as Record<string, string>;
		const h = Number.parseFloat(t.height ?? "");
		if (Number.isFinite(h) && h > 0) return Math.min(h, 100);
		const levels = Number.parseInt(t["building:levels"] ?? "", 10);
		if (Number.isFinite(levels) && levels > 0) return Math.min(levels * 3, 100);
	} catch {
		// ignore malformed tags
	}
	return 12;
}

/**
 * Grow a ring ~2% about its centroid. The Standard style extrudes the SAME
 * OSM footprints, so identical walls z-fight/interleave (stripes); the amber
 * shell must fully enclose the basemap volume. Done server-side (was
 * client-side) so the map can hand the URL to mapbox's GeoJSON source and let
 * the mapbox web worker fetch+parse the payload off the UI thread.
 */
function expandRing(
	ring: Array<{ lat: number; lng: number }>,
): [number, number][] {
	const pts = ring.map((p) => [p.lng, p.lat] as [number, number]);
	let cx = 0;
	let cy = 0;
	for (const [x, y] of pts) {
		cx += x;
		cy += y;
	}
	cx /= pts.length;
	cy /= pts.length;
	for (const p of pts) {
		p[0] = cx + (p[0] - cx) * 1.02;
		p[1] = cy + (p[1] - cy) * 1.02;
	}
	return pts;
}

// Memoized per process, but with a TTL: building assignments and RCN
// imports land while the dev/prod server keeps running, and a permanent
// cache would serve a stale txCount map (missing amber buildings).
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: CachedFeature[] | null = null;
let cacheAt = 0;

async function getFeatures(): Promise<CachedFeature[]> {
	if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;

	// Count transactions per building in one pass, then join.
	const txRows = await db
		.select({ buildingId: transactions.buildingId, count: count() })
		.from(transactions)
		.where(isNotNull(transactions.buildingId))
		.groupBy(transactions.buildingId);
	const txByBuilding = new Map(
		txRows.map((r) => [r.buildingId as number, r.count]),
	);

	const rows = await db
		.select({
			id: buildings.id,
			osmId: buildings.osmId,
			address: buildings.address,
			geometry: buildings.geometry,
			tags: buildings.tags,
		})
		.from(buildings);

	cache = rows
		.filter((r) => r.geometry)
		.map((r) => ({
			id: r.id,
			osmId: r.osmId,
			address: r.address,
			txCount: txByBuilding.get(r.id) ?? 0,
			height: buildingHeight(r.tags),
			// The stored geometry is a ring of {lat, lng}; wrap it into a
			// GeoJSON Polygon ([lng, lat] coordinate order), pre-expanded so
			// the client never has to touch the coordinates.
			geometry: {
				type: "Polygon" as const,
				coordinates: [
					expandRing(
						JSON.parse(r.geometry as string) as Array<{
							lat: number;
							lng: number;
						}>,
					),
				],
			},
		}))
		.filter((f) => f.txCount > 0);
	cacheAt = Date.now();
	return cache;
}

export const Route = createFileRoute("/api/buildings/geojson")({
	server: {
		handlers: {
			GET: async () => {
				const features = await getFeatures();
				return json({
					type: "FeatureCollection",
					features: features.map((f) => ({
						type: "Feature",
						// Feature id = OSM id: the map keys fill-extrusion
						// feature-state (basemap height sync) and click
						// lookups (/api/buildings/lookup?osmId=) by it.
						id: f.osmId,
						geometry: f.geometry,
						properties: {
							osmId: f.osmId,
							address: f.address,
							txCount: f.txCount,
							height: f.height,
						},
					})),
				});
			},
		},
	},
});
