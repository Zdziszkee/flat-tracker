import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, transactions } from "#/db/schema";

/**
 * GeoJSON point layer of building addresses (centroids) for buildings
 * with RCN history: shows street + housenumber labels on the amber 3D
 * footprints when zoomed in. Only history buildings are sent (~10k), so
 * the payload stays small.
 */

interface LabelFeature {
	osmId: number;
	address: string;
	lat: number;
	lng: number;
}

let cache: LabelFeature[] | null = null;

async function getLabels(): Promise<LabelFeature[]> {
	if (cache) return cache;

	const rows = await db
		.selectDistinct({
			osmId: buildings.osmId,
			address: buildings.address,
			lat: buildings.lat,
			lng: buildings.lng,
		})
		.from(buildings)
		.innerJoin(transactions, eq(transactions.buildingId, buildings.id));

	cache = rows
		.filter((r) => r.address && r.address.trim().length > 0)
		.map((r) => ({
			osmId: r.osmId,
			address: r.address as string,
			lat: r.lat,
			lng: r.lng,
		}));
	return cache;
}

export const Route = createFileRoute("/api/buildings/labels")({
	server: {
		handlers: {
			GET: async () => {
				const labels = await getLabels();
				return json({
					type: "FeatureCollection",
					features: labels.map((l) => ({
						type: "Feature",
						id: l.osmId,
						geometry: { type: "Point", coordinates: [l.lng, l.lat] },
						properties: { osmId: l.osmId, address: l.address },
					})),
				});
			},
		},
	},
});
