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

				// ---- Area comparison (1 km around the parcel, 5 years) -----
				// Land price per m² of nearby transactions vs the parcel's own
				// latest transaction: is this działka cheap or expensive for
				// the area, and is the local market rising?
				const anchorLat = row?.centroidLat ?? (Number.isFinite(lat) ? lat : null);
				const anchorLng = row?.centroidLng ?? (Number.isFinite(lng) ? lng : null);
				// Land parcels outside Kraków (GUGiK feed) quote prices per AR
				// (100 m²) — the geodetic convention for działki. Kraków zip
				// rows are flat transactions and stay per m².
				const landUnit = parcelId.startsWith("1261") ? "m2" : "ar";
				const unitMul = landUnit === "ar" ? 100 : 1;
				// Parcel land metadata (type/size) from the GUGiK import.
				const meta = await db.get<{
					landUse: string | null;
					zoning: string | null;
					areaHa: number | null;
				}>(sql`
					SELECT land_use AS landUse, zoning, area_ha AS areaHa
					FROM parcel_meta
					WHERE parcel_id = ${parcelId}
				`);

				// Land-use class of the subject parcel (from GUGiK meta) so we
				// compare rolna-to-rolna and zabudowana-to-zabudowana: a sale
				// WITH a house shows up as gruntyZabudowaneIZurbanizowane with
				// an order-of-magnitude higher price per ar.
				const ownMeta = await db.get<{
					landUse: string | null;
				}>(sql`SELECT land_use AS landUse FROM parcel_meta WHERE parcel_id = ${parcelId}`);
				const landGroup = (lu: string | null): string | null => {
					if (lu == null) return null;
					if (lu === "gruntyZabudowaneIZurbanizowane") return "zabudowana";
					if (lu === "gruntyRolne") return "rolna";
					if (lu === "gruntyLesne") return "leśna";
					return lu;
				};
				const ownGroup = landGroup(ownMeta?.landUse ?? null);
				let area: {
					unit: string;
					medianM2: number | null;
					txCount: number;
					txCount24m: number;
					byYear: Array<{ year: string; medianM2: number; tx: number }>;
					lastVsMedianPct: number | null;
					basedOn: Array<{
						date: string;
						price: number;
						perUnit: number;
						parcelId: string;
					}>;
				} | null = null;
				if (anchorLat != null && anchorLng != null) {
					const dLat = 1000 / 111_320;
					const dLng = 1000 / (111_320 * Math.cos((anchorLat * Math.PI) / 180));
					const cutoff5y = Math.floor(Date.now() / 1000) - 5 * 365 * 86400;
					const cutoff24m = Math.floor(Date.now() / 1000) - 730 * 86400;
					const median = (vals: number[]): number | null => {
						if (vals.length === 0) return null;
						const sorted = [...vals].sort((a, b) => a - b);
						return sorted[Math.floor(sorted.length / 2)];
					};
					// Compare like with like: rolna->rolna, budowlana->budowlana.
				// A sale WITH a house registers as gruntyZabudowane... with an
				// order-of-magnitude higher price per ar, so mixing classes
				// would poison the median.
				const groupSql = ownGroup
					? sql`AND (CASE m.land_use
							WHEN 'gruntyZabudowaneIZurbanizowane' THEN 'zabudowana'
							WHEN 'gruntyRolne' THEN 'rolna'
							WHEN 'gruntyLesne' THEN 'lesna'
							ELSE COALESCE(m.land_use, 'inne') END) = ${ownGroup}`
					: sql``;
				const nearby = ownGroup
					? await db
							.all<{
								pricePerM2: number;
								date: number;
								price: number;
								parcelId: string | null;
							}>(sql`
						SELECT t.pricePerM2, t.date, t.price,
						       t.parcel_id AS parcelId
						FROM transactions t
						JOIN parcel_meta m ON m.parcel_id = t.parcel_id
						WHERE t.pricePerM2 > 0
						  AND t.parcel_id IS NOT NULL
						  AND t.lat BETWEEN ${anchorLat - dLat} AND ${anchorLat + dLat}
						  AND t.lng BETWEEN ${anchorLng - dLng} AND ${anchorLng + dLng}
						  AND t.date >= ${cutoff5y}
						  ${groupSql}
					`)
					: await db
							.all<{
								pricePerM2: number;
								date: number;
								price: number;
								parcelId: string | null;
							}>(sql`
						SELECT pricePerM2, date, price, parcel_id AS parcelId
						FROM transactions
						WHERE pricePerM2 IS NOT NULL AND pricePerM2 > 0
						  AND lat BETWEEN ${anchorLat - dLat} AND ${anchorLat + dLat}
						  AND lng BETWEEN ${anchorLng - dLng} AND ${anchorLng + dLng}
						  AND date >= ${cutoff5y}
					`);

					const allM2 = nearby.map((r) => r.pricePerM2);
					const yearMap = new Map<string, number[]>();
					for (const r of nearby) {
						const y = new Date(r.date * 1000).getUTCFullYear().toString();
						yearMap.set(y, [...(yearMap.get(y) ?? []), r.pricePerM2]);
					}
					const lastTx = stats.recent.find((r) => r.pricePerM2 != null);
					const areaMedian = median(allM2);
					area = {
						unit: landUnit,
						medianM2:
							areaMedian != null
								? Math.round(areaMedian * unitMul * 100) / 100
								: null,
						txCount: nearby.length,
						txCount24m: nearby.filter((r) => r.date >= cutoff24m).length,
						byYear: [...yearMap.entries()]
							.map(([year, vals]) => ({
								year,
								medianM2:
									Math.round((median(vals) ?? 0) * unitMul * 100) / 100,
								tx: vals.length,
							}))
							.sort((a, b) => a.year.localeCompare(b.year)),
						basedOn: nearby
							.sort((a, b) => b.date - a.date)
							.slice(0, 8)
							.map((r) => ({
								date: new Date(r.date * 1000).toISOString().slice(0, 10),
								price: r.price,
								perUnit: Math.round(r.pricePerM2 * unitMul * 100) / 100,
								parcelId: r.parcelId ?? "",
							})),
						lastVsMedianPct:
							lastTx?.pricePerM2 != null && areaMedian != null && areaMedian > 0
								// ratio is unit-independent (raw per-m² on both sides)
								? Math.round(
										((lastTx.pricePerM2 - areaMedian) / areaMedian) * 1000,
									) / 10
								: null,
					};
				}

				return json({
					parcel: {
						id: parcelId,
						areaKnown: Boolean(row),
						stats,
						area,
						meta: meta ?? null,
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
