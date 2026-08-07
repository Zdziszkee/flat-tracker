import { createFileRoute } from "@tanstack/react-router"
import { json } from "@tanstack/react-start"
import { count, sql } from "drizzle-orm"

import { buildings, transactions } from "#/db/schema"

import { db } from "#/db/index"

/**
 * GeoJSON of all buildings with their RCN transaction counts, used by the
 * map to color buildings by price-history availability.
 */

interface CachedFeature {
	id: number
	osmId: number
	address: string | null
	txCount: number
	geometry: { type: "Polygon"; coordinates: number[][][] }
}

let cache: CachedFeature[] | null = null

async function getFeatures(): Promise<CachedFeature[]> {
	if (cache) return cache

	// Count transactions per building in one pass, then join.
	const txRows = await db
		.select({ buildingId: transactions.buildingId, count: count() })
		.from(transactions)
		.where(sql`${transactions.buildingId} is not null`)
		.groupBy(transactions.buildingId)
	const txByBuilding = new Map(
		txRows.map((r) => [r.buildingId as number, r.count]),
	)

	const rows = await db
		.select({
			id: buildings.id,
			osmId: buildings.osmId,
			address: buildings.address,
			geometry: buildings.geometry,
		})
		.from(buildings)

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
				type: "Polygon",
				coordinates: [
					(JSON.parse(r.geometry as string) as Array<{ lat: number; lon: number }>).map(
						(p) => [p.lon, p.lat],
					),
				],
			},
		}))
	return cache
}

export const Route = createFileRoute("/api/buildings/geojson")({
	server: {
		handlers: {
			GET: async () => {
				const features = await getFeatures()
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
				})
			},
		},
	},
})
