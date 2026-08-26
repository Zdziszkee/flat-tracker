import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, gte, isNotNull, lte } from "drizzle-orm";
import { db } from "#/db/index";
import { parcels, transactions } from "#/db/schema";

/**
 * Viewport-limited cadastral-parcel grid for the map.
 *
 * Given a bbox, returns the RCN_Dzialka polygons that overlap it as a
 * GeoJSON FeatureCollection. `properties.hasRcn` marks parcels that carry
 * at least one RCN transaction (computed from transactions.parcelId), so
 * the client can color them differently. The bbox predicate hits the
 * parcels_bbox_idx; a feature cap keeps extreme zoom-outs responsive.
 */

const MAX_FEATURES = 6000;

interface ParcelRow {
	parcelId: string;
	bboxMinLat: number;
	bboxMinLng: number;
	bboxMaxLat: number;
	bboxMaxLng: number;
	polygon: string;
}

/** Parcel ids with RCN history, memoized per process. */
let rcnParcelIds: Set<string> | null = null;
async function getRcnParcelIds(): Promise<Set<string>> {
	if (rcnParcelIds) return rcnParcelIds;
	const rows = await db
		.selectDistinct({ parcelId: transactions.parcelId })
		.from(transactions)
		.where(isNotNull(transactions.parcelId));
	rcnParcelIds = new Set(rows.map((r) => r.parcelId as string));
	return rcnParcelIds;
}

export const Route = createFileRoute("/api/parcels")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const minLng = Number(url.searchParams.get("minLng"));
				const minLat = Number(url.searchParams.get("minLat"));
				const maxLng = Number(url.searchParams.get("maxLng"));
				const maxLat = Number(url.searchParams.get("maxLat"));
				if (
					!Number.isFinite(minLng) ||
					!Number.isFinite(minLat) ||
					!Number.isFinite(maxLng) ||
					!Number.isFinite(maxLat)
				) {
					return json(
						{ error: "minLng/minLat/maxLng/maxLat required" },
						{
							status: 400,
						},
					);
				}

				const rows: ParcelRow[] = await db
					.select({
						parcelId: parcels.parcelId,
						bboxMinLat: parcels.bboxMinLat,
						bboxMinLng: parcels.bboxMinLng,
						bboxMaxLat: parcels.bboxMaxLat,
						bboxMaxLng: parcels.bboxMaxLng,
						polygon: parcels.polygon,
					})
					.from(parcels)
					.where(
						and(
							lte(parcels.bboxMinLng, maxLng),
							gte(parcels.bboxMaxLng, minLng),
							lte(parcels.bboxMinLat, maxLat),
							gte(parcels.bboxMaxLat, minLat),
						),
					)
					.limit(MAX_FEATURES);

				const withRcn = await getRcnParcelIds();

				const features = [];
				for (const r of rows) {
					let coords: unknown;
					try {
						coords = JSON.parse(r.polygon);
					} catch {
						continue;
					}
					features.push({
						type: "Feature" as const,
						geometry: { type: "Polygon" as const, coordinates: coords },
						properties: {
							parcelId: r.parcelId,
							hasRcn: withRcn.has(r.parcelId),
						},
					});
				}
				return json({ type: "FeatureCollection", features });
			},
		},
	},
});
