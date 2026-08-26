import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { parcels, transactions } from "#/db/schema";

/**
 * Click-to-inspect for the cadastral-parcel layer: given a clicked point
 * (or an explicit parcelId), return the parcel plus the RCN transaction
 * history of everything bound to it (transactions.parcelId).
 */

interface ParcelStats {
	txCount: number;
	avgPricePerM2: number | null;
	minPricePerM2: number | null;
	maxPricePerM2: number | null;
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

async function parcelStats(parcelId: string): Promise<ParcelStats> {
	const [agg] = await db
		.select({
			txCount: sql<number>`count(*)`,
			avgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
			minPricePerM2: sql<number | null>`min(${transactions.pricePerM2})`,
			maxPricePerM2: sql<number | null>`max(${transactions.pricePerM2})`,
		})
		.from(transactions)
		.where(eq(transactions.parcelId, parcelId));

	const byYear = await db
		.select({
			year: sql<string>`strftime('%Y', ${transactions.date}, 'unixepoch')`,
			count: sql<number>`count(*)`,
			avgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
		})
		.from(transactions)
		.where(eq(transactions.parcelId, parcelId))
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
		.where(eq(transactions.parcelId, parcelId))
		.orderBy(desc(transactions.date))
		.limit(5);

	return {
		txCount: agg?.txCount ?? 0,
		avgPricePerM2: agg?.avgPricePerM2 ?? null,
		minPricePerM2: agg?.minPricePerM2 ?? null,
		maxPricePerM2: agg?.maxPricePerM2 ?? null,
		byYear,
		recent,
	};
}

export const Route = createFileRoute("/api/parcels/lookup")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const parcelIdParam = url.searchParams.get("parcelId");
				const lat = Number(url.searchParams.get("lat"));
				const lng = Number(url.searchParams.get("lng"));

				let parcelId = parcelIdParam ?? null;

				// Point-in-polygon fallback when only a click point is known.
				if (!parcelId && Number.isFinite(lat) && Number.isFinite(lng)) {
					const candidates = await db
						.select({ parcelId: parcels.parcelId, polygon: parcels.polygon })
						.from(parcels)
						.where(
							sql`${parcels.bboxMinLng} <= ${lng} and ${parcels.bboxMaxLng} >= ${lng}
								and ${parcels.bboxMinLat} <= ${lat} and ${parcels.bboxMaxLat} >= ${lat}`,
						);
					for (const c of candidates) {
						try {
							const ring = (
								JSON.parse(c.polygon) as { coordinates: number[][][] }
							).coordinates[0];
							if (pointInRing(lng, lat, ring)) {
								parcelId = c.parcelId;
								break;
							}
						} catch {
							// skip malformed geometry
						}
					}
				}

				if (!parcelId) return json({ parcel: null });

				const [row] = await db
					.select()
					.from(parcels)
					.where(eq(parcels.parcelId, parcelId))
					.limit(1);

				const stats = await parcelStats(parcelId);
				return json({
					parcel: {
						id: parcelId,
						areaKnown: Boolean(row),
						stats,
					},
				});
			},
		},
	},
});

/** Ray-casting test of lng/lat against a GeoJSON [lng,lat] ring. */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i][0];
		const yi = ring[i][1];
		const xj = ring[j][0];
		const yj = ring[j][1];
		const intersect =
			yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}
