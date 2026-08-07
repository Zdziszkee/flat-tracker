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
	geometry: { type: "Polygon"; coordinates: number[][][] };
}

let cache: CachedFeature[] | null = null;

async function getFeatures(): Promise<CachedFeature[]> {
	if (cache) return cache;

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
		})
		.from(buildings);

	cache = rows
		.filter((r) => r.geometry)
		.map((r) => ({
			id: r.id,
			osmId: r.osmId,
			address: r.address,
			txCount: txByBuilding.get(r.id) ?? 0,
			// The stored geometry is a ring of {lat, lon}; wrap it into a
			// GeoJSON Polygon ([lng, lat] coordinate order).
			geometry: {
				type: "Polygon" as const,
				coordinates: [
					(
						JSON.parse(r.geometry as string) as Array<{
							lat: number;
							lon: number;
						}>
					).map((p) => [p.lon, p.lat]),
				],
			},
		}))
		.filter((f) => f.txCount > 0);
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
						id: f.id,
						geometry: f.geometry,
						properties: {
							osmId: f.osmId,
							address: f.address,
							txCount: f.txCount,
						},
					})),
				});
			},
		},
	},
});
