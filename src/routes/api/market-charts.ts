import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { inMalopolska } from "#/db/region";

/**
 * Market-charts feed: 15 pre-aggregated series for the /market dashboard.
 * One request, server-side SQL — the page only renders.
 *
 * Storage conventions matter here (AGENTS.md): timestamps are unixepoch
 * integers (transactions.date, listings.first_seen_at, availability.*) and
 * drizzle column names are camelCase (pricePerM2, areaM2) except the
 * explicitly-named ones (parcel_id, first_seen_at, ...).
 */

/** TERYT4 -> readable powiat name (transactions.parcel_id prefix). */
const POWIAT_NAMES: Record<string, string> = {
	"1201": "bocheński",
	"1202": "brzeski",
	"1203": "chrzanowski",
	"1204": "dąbrowski",
	"1205": "gorlicki",
	"1206": "krakowski",
	"1207": "limanowski",
	"1208": "miechowski",
	"1209": "myślenicki",
	"1210": "nowosądecki",
	"1211": "nowotarski",
	"1212": "olkuski",
	"1213": "oświęcimski",
	"1214": "proszowicki",
	"1215": "suski",
	"1216": "tarnowski",
	"1217": "tatrzański",
	"1218": "wadowicki",
	"1219": "wielicki",
	"1261": "Kraków",
	"1262": "Nowy Sącz",
	"1263": "Tarnów",
};

/** Epoch cutoffs computed in JS (SQLite int-vs-text comparison trap). */
const now = Date.now();
const daysAgo = (d: number): number =>
	Math.floor((now - d * 86_400_000) / 1000);

/** City buckets by lat/lng for rental-market analytics. */
const CITY_CASE = sql`
	CASE
		WHEN lat BETWEEN 50.02 AND 50.12 AND lng BETWEEN 19.80 AND 20.12 THEN 'Kraków'
		WHEN lat BETWEEN 49.98 AND 50.05 AND lng BETWEEN 20.90 AND 21.05 THEN 'Tarnów'
		WHEN lat BETWEEN 49.58 AND 49.66 AND lng BETWEEN 20.64 AND 20.78 THEN 'Nowy Sącz'
		WHEN lat BETWEEN 49.24 AND 49.34 AND lng BETWEEN 19.88 AND 20.04 THEN 'Zakopane'
		WHEN lat BETWEEN 49.98 AND 50.06 AND lng BETWEEN 19.22 AND 19.38 THEN 'Oświęcim'
		WHEN lat BETWEEN 49.97 AND 50.03 AND lng BETWEEN 20.02 AND 20.11 THEN 'Wieliczka'
		WHEN lat BETWEEN 49.38 AND 49.46 AND lng BETWEEN 20.90 AND 21.02 THEN 'Krynica'
		WHEN lat IS NOT NULL THEN 'reszta'
		ELSE 'brak lokalizacji'
	END
`;

async function all<T>(q: ReturnType<typeof sql>): Promise<T[]> {
	return db.all<T>(q);
}

export const Route = createFileRoute("/api/market-charts")({
	server: {
		handlers: {
			GET: async () => {
				// ---- 1. RCN price trend by month ----------------------------
				const priceTrend = await all<{
					month: string;
					avgM2: number;
					tx: number;
				}>(sql`
					SELECT substr(datetime(date, 'unixepoch'), 1, 7) AS month,
					       avg(pricePerM2) AS avgM2,
					       count(*) AS tx
					FROM transactions
					WHERE ${inMalopolska} AND pricePerM2 BETWEEN 500 AND 40000
					  AND date BETWEEN ${daysAgo(365 * 12)} AND ${daysAgo(0)}
					GROUP BY month ORDER BY month
				`);

				// ---- 2. YoY price growth by powiat --------------------------
				const yoyRaw = await all<{
					teryt: string;
					window: string;
					avgM2: number;
					windowTx: number;
				}>(sql`
					SELECT substr(parcel_id, 1, 4) AS teryt,
					       CASE WHEN date >= ${daysAgo(365)}
					            THEN 'recent' ELSE 'prior' END AS window,
					       avg(pricePerM2) AS avgM2,
					       count(*) AS windowTx
					FROM transactions
					WHERE ${inMalopolska} AND pricePerM2 BETWEEN 500 AND 40000
					  AND parcel_id IS NOT NULL
					  AND date BETWEEN ${daysAgo(365 * 12)} AND ${daysAgo(0)}
					GROUP BY teryt, window
				`);
				const txCountRaw = await all<{ teryt: string; tx: number }>(sql`
					SELECT substr(parcel_id, 1, 4) AS teryt, count(*) AS tx
					FROM transactions
					WHERE ${inMalopolska} AND parcel_id IS NOT NULL AND date >= ${daysAgo(365)}
					GROUP BY teryt
				`);
				const txCount = new Map(txCountRaw.map((r) => [r.teryt, r.tx]));
				const byPowiat = new Map<string, { recent?: number; prior?: number }>();
				const winTx = new Map<string, number>();
				for (const r of yoyRaw) {
					const e = byPowiat.get(r.teryt) ?? {};
					if (r.window === "recent") e.recent = r.avgM2;
					else e.prior = r.avgM2;
					byPowiat.set(r.teryt, e);
					winTx.set(`${r.teryt}:${r.window}`, r.windowTx);
				}
				const yoyByPowiat = [...byPowiat.entries()]
					.filter(([teryt]) => POWIAT_NAMES[teryt] != null)
					.map(([teryt, e]) => ({
						powiat: POWIAT_NAMES[teryt] ?? teryt,
						growthPct:
							e.recent != null && e.prior != null && e.prior > 0
								? ((e.recent - e.prior) / e.prior) * 100
								: null,
						recent: e.recent != null ? Math.round(e.recent) : null,
						prior: e.prior != null ? Math.round(e.prior) : null,
						tx: txCount.get(teryt) ?? 0,
					}))
					.filter((r) => {
						if (r.growthPct == null || Math.abs(r.growthPct) > 200) {
							return false;
						}
						const key = Object.keys(POWIAT_NAMES).find(
							(k) => POWIAT_NAMES[k] === r.powiat,
						);
						if (!key) return false;
						return (
							(winTx.get(`${key}:recent`) ?? 0) >= 10 &&
							(winTx.get(`${key}:prior`) ?? 0) >= 10
						);
					})
					.sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0));

				// ---- 3. Transaction volume by month -------------------------
				const txVolume = await all<{ month: string; tx: number }>(sql`
					SELECT substr(datetime(date, 'unixepoch'), 1, 7) AS month,
					       count(*) AS tx
					FROM transactions
					WHERE ${inMalopolska} AND date BETWEEN ${daysAgo(365 * 12)} AND ${daysAgo(0)}
					GROUP BY month ORDER BY month
				`);

				// ---- 4. Primary vs secondary by powiat ----------------------
				const primaryRaw = await all<{
					teryt: string;
					market: number;
					avgM2: number;
				}>(sql`
					SELECT substr(parcel_id, 1, 4) AS teryt, market,
					       avg(pricePerM2) AS avgM2
					FROM transactions
					WHERE ${inMalopolska} AND pricePerM2 BETWEEN 500 AND 40000
					  AND parcel_id IS NOT NULL
					  AND market IN (1, 2)
					  AND date BETWEEN ${daysAgo(365 * 12)} AND ${daysAgo(0)}
					GROUP BY teryt, market HAVING count(*) >= 5
				`);
				const pv = new Map<string, { wtorny?: number; pierwotny?: number }>();
				for (const r of primaryRaw) {
					const e = pv.get(r.teryt) ?? {};
					// RCN market codes follow our Kraków zip import: 1 = wtórny,
					// 2 = pierwotny.
					if (r.market === 1) e.wtorny = Math.round(r.avgM2);
					else e.pierwotny = Math.round(r.avgM2);
					pv.set(r.teryt, e);
				}
				const primaryVsSecondary = [...pv.entries()]
					.filter(([teryt]) => POWIAT_NAMES[teryt] != null)
					.filter(([, e]) => e.wtorny != null && e.pierwotny != null)
					.map(([teryt, e]) => ({
						powiat: POWIAT_NAMES[teryt] ?? teryt,
						wtorny: e.wtorny ?? 0,
						pierwotny: e.pierwotny ?? 0,
					}));

				// ---- 5. Asking vs transaction price by month ----------------
				const askTrend = await all<{ month: string; avgM2: number }>(sql`
					SELECT substr(datetime(first_seen_at, 'unixepoch'), 1, 7) AS month,
					       avg(pricePerM2) AS avgM2
					FROM listings
					WHERE offer_type = 'sale' AND pricePerM2 IS NOT NULL
					  AND first_seen_at IS NOT NULL
					  AND first_seen_at >= ${daysAgo(730)}
					GROUP BY month
				`);
				const askMap = new Map(askTrend.map((r) => [r.month, r.avgM2]));
				const offerVsTxGap = priceTrend
					.filter((r) => askMap.has(r.month))
					.map((r) => {
						const ask = askMap.get(r.month) as number;
						return {
							month: r.month,
							askM2: Math.round(ask),
							txM2: Math.round(r.avgM2),
							gapPct: ((ask - r.avgM2) / r.avgM2) * 100,
						};
					});

				// ---- 6. Long-term gross yield by city -----------------------
				const grossYieldByCity = await all<{
					city: string;
					saleM2: number;
					rentM2: number;
					saleCount: number;
					rentCount: number;
				}>(sql`
					WITH s AS (
						SELECT ${CITY_CASE} AS city, avg(pricePerM2) AS saleM2,
						       count(*) AS saleCount
						FROM listings
						WHERE offer_type = 'sale' AND pricePerM2 IS NOT NULL
						GROUP BY city HAVING count(*) >= 5
					), r AS (
						SELECT ${CITY_CASE} AS city, avg(pricePerM2) AS rentM2,
						       count(*) AS rentCount
						FROM listings
						WHERE offer_type = 'long_term_rental' AND pricePerM2 IS NOT NULL
						GROUP BY city HAVING count(*) >= 5
					)
					SELECT s.city, s.saleM2, r.rentM2, s.saleCount, r.rentCount
					FROM s JOIN r ON r.city = s.city
					ORDER BY (r.rentM2 * 12 * 100.0 / s.saleM2) DESC
				`);
				const yieldRows = grossYieldByCity
					.filter((r) => r.city !== "brak lokalizacji")
					.map((r) => ({
						...r,
						yieldPct: (r.rentM2 * 12 * 100) / r.saleM2,
					}));

				// ---- 7. STR occupancy by city -------------------------------
				const strOccupancyByCity = await all<{
					city: string;
					occupancy: number;
					n: number;
				}>(sql`
					SELECT ${CITY_CASE} AS city,
					       avg(o.occupancy_rate) AS occupancy,
					       count(*) AS n
					FROM listing_occupancy o
					JOIN listings l ON l.id = o.listing_id
					WHERE l.lat IS NOT NULL
					GROUP BY city
					HAVING count(*) >= 3
					ORDER BY occupancy DESC
				`);

				// ---- 8. STR nightly price by month (airbnb vs booking) ------
				const strPriceByMonth = await all<{
					month: string;
					source: string;
					avgPrice: number;
				}>(sql`
					SELECT m.month AS month, l.source AS source,
					       avg(m.avg_effective_nightly_price) AS avgPrice
					FROM listing_monthly_price m
					JOIN listings l ON l.id = m.listing_id
					WHERE m.avg_effective_nightly_price IS NOT NULL
					  AND l.source IN ('airbnb', 'booking')
					GROUP BY m.month, l.source
					ORDER BY m.month
				`);

				// ---- 9. Occupancy by month (seasonality) --------------------
				const occupancyByMonth = await all<{
					month: string;
					occupancy: number;
				}>(sql`
					SELECT month, avg(occupancy_rate) AS occupancy
					FROM listing_occupancy
					GROUP BY month ORDER BY month
				`);

				// ---- 10. Weekday premium ------------------------------------
				const weekdayPremium = await all<{
					weekday: number;
					avgPrice: number;
					bookedShare: number;
				}>(sql`
					SELECT weekday, avg(avg_effective_nightly_price) AS avgPrice,
					       avg(CASE WHEN sample_days > 0
					            THEN booked_nights * 1.0 / sample_days ELSE 0 END)
					         AS bookedShare
					FROM listing_weekday_stats
					WHERE avg_effective_nightly_price IS NOT NULL
					GROUP BY weekday ORDER BY weekday
				`);

				// ---- 11. Occupancy vs yield scatter (city level) ------------
				const occMap = new Map(
					strOccupancyByCity.map((r) => [r.city, r.occupancy]),
				);
				const occupancyVsYield = yieldRows
					.filter((r) => occMap.has(r.city))
					.map((r) => ({
						city: r.city,
						yieldPct: r.yieldPct,
						occupancy: (occMap.get(r.city) ?? 0) * 100,
					}));

				// ---- 12. Price per m2 by area segment -----------------------
				const areaSegments = await all<{
					label: string;
					avgM2: number;
					n: number;
				}>(sql`
					SELECT label, avg(pricePerM2) AS avgM2, count(*) AS n
					FROM (
						SELECT CASE
							WHEN areaM2 < 30 THEN '<30 m²'
							WHEN areaM2 < 50 THEN '30-50'
							WHEN areaM2 < 70 THEN '50-70'
							WHEN areaM2 < 100 THEN '70-100'
							ELSE '100+' END AS label,
						pricePerM2
						FROM listings
						WHERE offer_type = 'sale' AND pricePerM2 IS NOT NULL
						  AND areaM2 IS NOT NULL
					)
					GROUP BY label
					ORDER BY CASE label
						WHEN '<30 m²' THEN 1 WHEN '30-50' THEN 2 WHEN '50-70' THEN 3
						WHEN '70-100' THEN 4 ELSE 5 END
				`);

				// ---- 13. New supply: listings per month by segment ----------
				const newSupply = await all<{
					month: string;
					segment: string;
					n: number;
				}>(sql`
					SELECT substr(datetime(first_seen_at, 'unixepoch'), 1, 7) AS month,
					       CASE WHEN offer_type = 'rental' THEN 'najem'
					            WHEN source IN ('airbnb', 'booking') THEN 'STR'
					            ELSE 'sprzedaż' END AS segment,
					       count(*) AS n
					FROM listings
					WHERE first_seen_at IS NOT NULL
					  AND first_seen_at >= ${daysAgo(730)}
					GROUP BY month, segment ORDER BY month
				`);

				// ---- 14. Avg nightly by city (STR asking price) -------------
				const nightlyByCity = await all<{
					city: string;
					source: string;
					avgNightly: number;
					n: number;
				}>(sql`
					SELECT ${CITY_CASE} AS city, source,
					       avg(price) AS avgNightly, count(*) AS n
					FROM listings
					WHERE source IN ('airbnb', 'booking') AND price IS NOT NULL
					GROUP BY city, source
					HAVING count(*) >= 3 AND city != 'brak lokalizacji'
					ORDER BY avgNightly DESC
				`);

				// ---- 1b. Rent histogram: liczba ofert wg przedziału czynszu --
				interface RentHistRow {
					price: number;
					utilities: string | null;
				}
				const rentRows = await all<RentHistRow>(sql`
					SELECT price, utilities
					FROM listings
					WHERE offer_type = 'long_term_rental'
					  AND price IS NOT NULL AND price > 0
				`);
				const rentBuckets = [
					{ label: "<1500", max: 1500 },
					{ label: "1500-1999", max: 2000 },
					{ label: "2000-2499", max: 2500 },
					{ label: "2500-2999", max: 3000 },
					{ label: "3000-3499", max: 3500 },
					{ label: "3500-3999", max: 4000 },
					{ label: "4000-4999", max: 5000 },
					{ label: "5000+", max: Infinity },
				];
				const rentPrices = rentRows.map((r) => r.price);
				const rentHistogram = rentBuckets.map((b) => ({
					label: b.label,
					n: rentPrices.filter((p) => p < b.max).length,
				}));
				// overlapping ranges need cumulative subtraction
				for (let i = rentHistogram.length - 1; i > 0; i--) {
					rentHistogram[i].n -= rentHistogram[i - 1].n;
				}
				const rentSorted = [...rentPrices].sort((a, b) => a - b);
				const rentMeta = {
					avg: Math.round(
						rentPrices.reduce((a, b) => a + b, 0) /
							Math.max(1, rentPrices.length),
					),
					median:
						rentSorted.length > 0
							? rentSorted[Math.floor(rentSorted.length / 2)]
							: 0,
				};

				// ---- 1c. Opłaty (czynsz adm.) histogram ---------------------
				const czynszVals: number[] = [];
				for (const r of rentRows) {
					try {
						const u = JSON.parse(r.utilities ?? "{}") as {
							czynsz?: number | null;
						};
						if (typeof u.czynsz === "number" && u.czynsz > 0) {
							czynszVals.push(u.czynsz);
						}
					} catch {
						// malformed utilities JSON
					}
				}
				const czynszBuckets = [
					{ label: "0-199", max: 200 },
					{ label: "200-399", max: 400 },
					{ label: "400-599", max: 600 },
					{ label: "600-799", max: 800 },
					{ label: "800-999", max: 1000 },
					{ label: "1000-1499", max: 1500 },
					{ label: "1500+", max: Infinity },
				];
				const oplatyHistogram = czynszBuckets.map((b) => ({
					label: b.label,
					n: czynszVals.filter((p) => p < b.max).length,
				}));
				for (let i = oplatyHistogram.length - 1; i > 0; i--) {
					oplatyHistogram[i].n -= oplatyHistogram[i - 1].n;
				}
				const czynszSorted = [...czynszVals].sort((a, b) => a - b);
				const oplatyMeta = {
					avg: Math.round(
						czynszVals.reduce((a, b) => a + b, 0) /
							Math.max(1, czynszVals.length),
					),
					median:
						czynszSorted.length > 0
							? czynszSorted[Math.floor(czynszSorted.length / 2)]
							: 0,
				};

				// ---- 1c2. Total cost (czynsz + opłaty) histogram ------------
				const totalVals = rentRows.map((r) => {
					let czynsz = 0;
					try {
						const u = JSON.parse(r.utilities ?? "{}") as {
							czynsz?: number | null;
						};
						if (typeof u.czynsz === "number") czynsz = u.czynsz;
					} catch {
						// no utilities info -> treat as 0
					}
					return r.price + czynsz;
				});
				const totalBuckets = [
					{ label: "<2000", max: 2000 },
					{ label: "2000-2499", max: 2500 },
					{ label: "2500-2999", max: 3000 },
					{ label: "3000-3499", max: 3500 },
					{ label: "3500-3999", max: 4000 },
					{ label: "4000-4999", max: 5000 },
					{ label: "5000+", max: Infinity },
				];
				const totalHistogram = totalBuckets.map((b) => ({
					label: b.label,
					n: totalVals.filter((p) => p < b.max).length,
				}));
				for (let i = totalHistogram.length - 1; i > 0; i--) {
					totalHistogram[i].n -= totalHistogram[i - 1].n;
				}
				const totalSorted = [...totalVals].sort((a, b) => a - b);
				const totalMeta = {
					avg: Math.round(
						totalVals.reduce((a, b) => a + b, 0) /
							Math.max(1, totalVals.length),
					),
					median:
						totalSorted.length > 0
							? totalSorted[Math.floor(totalSorted.length / 2)]
							: 0,
				};

				const txByRooms = await all<{
					label: string;
					avgM2: number;
					n: number;
				}>(sql`
					SELECT CASE
						WHEN rooms IS NULL OR rooms = 0 THEN 'n/d'
						WHEN rooms = 1 THEN '1 pokój'
						WHEN rooms = 2 THEN '2 pokoje'
						WHEN rooms = 3 THEN '3 pokoje'
						WHEN rooms = 4 THEN '4 pokoje'
						ELSE '5+' END AS label,
					avg(pricePerM2) AS avgM2, count(*) AS n
					FROM transactions
					WHERE ${inMalopolska} AND pricePerM2 BETWEEN 500 AND 40000
					  AND rooms IS NOT NULL
					  AND date >= ${daysAgo(730)}
					GROUP BY label
					ORDER BY CASE label
						WHEN 'n/d' THEN 0 WHEN '1 pokój' THEN 1 WHEN '2 pokoje' THEN 2
						WHEN '3 pokoje' THEN 3 WHEN '4 pokoje' THEN 4 ELSE 5 END
				`);

				// ---- 15. Price-drop activity by city ------------------------
				const priceDropsByCity = await all<{
					city: string;
					dropped: number;
					total: number;
					dropPct: number;
				}>(sql`
					WITH hist AS (
						SELECT l.id AS lid, ${CITY_CASE} AS city,
						       min(h.price) AS minP, max(h.price) AS maxP
						FROM listing_history h
						JOIN listings l ON l.id = h.listing_id
						WHERE l.offer_type = 'sale'
						GROUP BY l.id
						HAVING max(captured_at) >= ${daysAgo(30)}
					)
					SELECT city,
					       sum(CASE WHEN minP < maxP THEN 1 ELSE 0 END) AS dropped,
					       count(*) AS total,
					       100.0 * sum(CASE WHEN minP < maxP THEN 1 ELSE 0 END)
					         / count(*) AS dropPct
					FROM hist
					WHERE city != 'brak lokalizacji'
					GROUP BY city
					HAVING count(*) >= 5
					ORDER BY dropPct DESC
				`);

				return json({
					rentHistogram,
					rentMeta,
					oplatyHistogram,
					oplatyMeta,
					totalHistogram,
					totalMeta,
					txByRooms,
					priceTrend,
					yoyByPowiat,
					txVolume,
					primaryVsSecondary,
					offerVsTxGap,
					grossYieldByCity: yieldRows,
					strOccupancyByCity,
					strPriceByMonth,
					occupancyByMonth,
					weekdayPremium,
					occupancyVsYield,
					areaSegments,
					newSupply,
					nightlyByCity,
					priceDropsByCity,
				});
			},
		},
	},
});
