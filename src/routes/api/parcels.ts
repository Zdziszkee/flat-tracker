import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, gte, isNotNull, lte } from "drizzle-orm";
import { db } from "#/db/index";
import { parcels, transactions } from "#/db/schema";

/**
 * Viewport-limited cadastral-parcel grid for the map.
 *
 * Given a bbox, returns the parcel polygons that overlap it as a
 * GeoJSON FeatureCollection. Sources: RCN_Dzialka (Krakow) and GUGiK
 * KIEG WFS (region-wide małopolska), one table. `properties.hasRcn`
 * marks parcels that carry at least one RCN transaction (computed from
 * transactions.parcelId); obreb/gmina give non-RCN parcels some popup
 * context. The bbox predicate hits the parcels_bbox_idx; a feature cap
 * keeps extreme zoom-outs responsive.
 */

const MAX_FEATURES = 12000;

/**
 * Drop points closer than ~`tol` degrees to their predecessor (plus the
 * closing point). With 5.6M parcels region-wide, raw rings average ~10-15
 * vertices; at low zoom the sub-meter wiggles are invisible. Tolerance is
 * derived from the viewport so detail survives when zoomed in.
 */
function simplifyRing(ring: number[][], tolDeg: number): number[][] {
	if (ring.length <= 5) return ring;
	const tol2 = tolDeg * tolDeg;
	const out: number[][] = [ring[0]];
	for (let i = 1; i < ring.length - 1; i++) {
		const prev = out[out.length - 1];
		const dx = ring[i][0] - prev[0];
		const dy = ring[i][1] - prev[1];
		if (dx * dx + dy * dy >= tol2) out.push(ring[i]);
	}
	const last = ring[ring.length - 1];
	const first = out[0];
	if (
		(last[0] !== first[0] || last[1] !== first[1]) &&
		out.length > 0 &&
		out[out.length - 1] !== ring[ring.length - 1]
	) {
		// re-close with the original final point semantics: ensure ring closure
		out.push([...first]);
	} else if (out[out.length - 1] !== first) {
		out.push([...first]);
	}
	return out.length >= 4 ? out : ring;
}

interface ParcelRow {
	parcelId: string;
	bboxMinLat: number;
	bboxMinLng: number;
	bboxMaxLat: number;
	bboxMaxLng: number;
	polygon: string;
	obreb: string | null;
	gmina: string | null;
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
				// Zoom drives ring simplification: ~0.6 px worth of degrees.
				const zoom = Number(url.searchParams.get("zoom") ?? "16");
				const tolDeg =
					(360 / 2 ** (Number.isFinite(zoom) ? zoom : 16)) * (0.6 / 512);
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
						obreb: parcels.obreb,
						gmina: parcels.gmina,
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
						// RCN rows store [{lat,lng}…]; EGIB rows store the same
						// shape. Convert to GeoJSON [lng,lat] pairs and CLOSE the
						// ring — first == last is required by the GeoJSON spec,
						// and mapbox-gl silently drops most unclosed polygons.
						const parsed = JSON.parse(r.polygon) as Array<{
							lat: number;
							lng: number;
						}>;
						if (!Array.isArray(parsed) || parsed.length < 3) continue;
						const full = parsed.map((p) => [p.lng, p.lat]);
						const first = full[0];
						const last = full[full.length - 1];
						if (first[0] !== last[0] || first[1] !== last[1]) {
							full.push([...first]);
						}
						const ring = simplifyRing(full, tolDeg);
						coords = [ring];
					} catch {
						continue;
					}
					features.push({
						type: "Feature" as const,
						geometry: { type: "Polygon" as const, coordinates: coords },
						properties: {
							parcelId: r.parcelId,
							hasRcn: withRcn.has(r.parcelId),
							obreb: r.obreb,
							gmina: r.gmina,
						},
					});
				}
				return json({ type: "FeatureCollection", features });
			},
		},
	},
});
