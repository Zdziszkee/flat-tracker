import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, eq, gte, lte } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, transactions } from "#/db/schema";

/**
 * GeoJSON point layer of building addresses (centroids) for buildings
 * with RCN history: shows street + housenumber labels on the amber 3D
 * footprints when zoomed in. The map asks for the current viewport at
 * zoom >= 16. An unbounded dump is only available with `?all=1`, because
 * the full payload is ~38 MB.
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

async function getLabelsInBbox(
	minLng: number,
	minLat: number,
	maxLng: number,
	maxLat: number,
): Promise<LabelFeature[]> {
	const rows = await db
		.selectDistinct({
			osmId: buildings.osmId,
			address: buildings.address,
			lat: buildings.lat,
			lng: buildings.lng,
		})
		.from(buildings)
		.innerJoin(transactions, eq(transactions.buildingId, buildings.id))
		.where(
			and(
				gte(buildings.lat, minLat),
				lte(buildings.lat, maxLat),
				gte(buildings.lng, minLng),
				lte(buildings.lng, maxLng),
			),
		);
	return rows
		.filter((row) => row.address && row.address.trim().length > 0)
		.map((row) => ({
			osmId: row.osmId,
			address: row.address as string,
			lat: row.lat,
			lng: row.lng,
		}));
}

export const Route = createFileRoute("/api/buildings/labels")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const params = new URL(request.url).searchParams;
				const bbox = params.get("bbox")?.split(",").map(Number);
				const all = params.get("all") === "1";
				if (!all && (bbox?.length !== 4 || !bbox.every(Number.isFinite))) {
					return json(
						{ error: "bbox=minLng,minLat,maxLng,maxLat required" },
						{ status: 400 },
					);
				}
				const labels =
					all || !bbox
						? await getLabels()
						: await getLabelsInBbox(bbox[0], bbox[1], bbox[2], bbox[3]);
				return json({
					type: "FeatureCollection",
					features: labels.map((l) => ({
						type: "Feature",
						id: l.osmId,
						geometry: {
							type: "Point",
							// 5 decimals ≈ 1.1 m: full float precision doubled the
							// label payload for no visible difference.
							coordinates: [
								Math.round(l.lng * 1e5) / 1e5,
								Math.round(l.lat * 1e5) / 1e5,
							],
						},
						// The feature id already carries the OSM id (the popup
						// looks details up by it); only the text field is needed.
						properties: { address: l.address },
					})),
				});
			},
		},
	},
});
