import { sql } from "drizzle-orm";

import { daysAgo, monthExpr } from "#/db/sql";
import {
	all,
	average,
	CITY_CASE,
	czynszFromUtilities,
	histogram,
	median,
} from "./shared";

export interface AskTrendRow {
	month: string;
	avgM2: number;
}

export interface GrossYieldRow {
	city: string;
	saleM2: number;
	rentM2: number;
	saleCount: number;
	rentCount: number;
	yieldPct: number;
}

export interface AreaSegmentRow {
	label: string;
	avgM2: number;
	n: number;
}

export interface SupplyRow {
	month: string;
	segment: string;
	n: number;
}

export interface NightlyRow {
	city: string;
	source: string;
	avgNightly: number;
	n: number;
}

export interface PriceDropRow {
	city: string;
	dropped: number;
	total: number;
	dropPct: number;
}

export interface HistogramRow {
	label: string;
	n: number;
}

export interface RentHistograms {
	rentHistogram: HistogramRow[];
	rentMeta: { avg: number; median: number };
	oplatyHistogram: HistogramRow[];
	oplatyMeta: { avg: number; median: number };
	totalHistogram: HistogramRow[];
	totalMeta: { avg: number; median: number };
}

export async function getAskTrend(): Promise<AskTrendRow[]> {
	return all<AskTrendRow>(sql`
		SELECT ${monthExpr(sql`first_seen_at`)} AS month,
		       avg(pricePerM2) AS avgM2
		FROM listings
		WHERE offer_type = 'sale' AND pricePerM2 IS NOT NULL
		  AND first_seen_at IS NOT NULL
		  AND first_seen_at >= ${daysAgo(730)}
		GROUP BY month
	`);
}

export async function getGrossYieldByCity(): Promise<GrossYieldRow[]> {
	const rows = await all<{
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
	return rows
		.filter((row) => row.city !== "brak lokalizacji")
		.map((row) => ({
			...row,
			yieldPct: (row.rentM2 * 12 * 100) / row.saleM2,
		}));
}

export async function getAreaSegments(): Promise<AreaSegmentRow[]> {
	return all<AreaSegmentRow>(sql`
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
}

export async function getNewSupply(): Promise<SupplyRow[]> {
	return all<SupplyRow>(sql`
		SELECT ${monthExpr(sql`first_seen_at`)} AS month,
		       CASE WHEN offer_type = 'rental' THEN 'najem'
		            WHEN source IN ('airbnb', 'booking') THEN 'STR'
		            ELSE 'sprzedaż' END AS segment,
		       count(*) AS n
		FROM listings
		WHERE first_seen_at IS NOT NULL
		  AND first_seen_at >= ${daysAgo(730)}
		GROUP BY month, segment ORDER BY month
	`);
}

export async function getNightlyByCity(): Promise<NightlyRow[]> {
	return all<NightlyRow>(sql`
		SELECT ${CITY_CASE} AS city, source,
		       avg(price) AS avgNightly, count(*) AS n
		FROM listings
		WHERE source IN ('airbnb', 'booking') AND price IS NOT NULL
		GROUP BY city, source
		HAVING count(*) >= 3 AND city != 'brak lokalizacji'
		ORDER BY avgNightly DESC
	`);
}

export async function getPriceDropsByCity(): Promise<PriceDropRow[]> {
	return all<PriceDropRow>(sql`
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
}

export async function getRentHistograms(): Promise<RentHistograms> {
	const rows = await all<{ price: number; utilities: string | null }>(sql`
		SELECT price, utilities
		FROM listings
		WHERE offer_type = 'long_term_rental'
		  AND price IS NOT NULL AND price > 0
	`);
	const rentPrices = rows.map((row) => row.price);
	const czynsz = rows
		.map((row) => czynszFromUtilities(row.utilities))
		.filter((value) => value > 0);
	const totals = rows.map(
		(row) => row.price + czynszFromUtilities(row.utilities),
	);

	const rentHistogram = histogram(rentPrices, [
		{ label: "<1500", max: 1500 },
		{ label: "1500-1999", max: 2000 },
		{ label: "2000-2499", max: 2500 },
		{ label: "2500-2999", max: 3000 },
		{ label: "3000-3499", max: 3500 },
		{ label: "3500-3999", max: 4000 },
		{ label: "4000-4999", max: 5000 },
		{ label: "5000+", max: Number.POSITIVE_INFINITY },
	]);
	const oplatyHistogram = histogram(czynsz, [
		{ label: "0-199", max: 200 },
		{ label: "200-399", max: 400 },
		{ label: "400-599", max: 600 },
		{ label: "600-799", max: 800 },
		{ label: "800-999", max: 1000 },
		{ label: "1000-1499", max: 1500 },
		{ label: "1500+", max: Number.POSITIVE_INFINITY },
	]);
	const totalHistogram = histogram(totals, [
		{ label: "<2000", max: 2000 },
		{ label: "2000-2499", max: 2500 },
		{ label: "2500-2999", max: 3000 },
		{ label: "3000-3499", max: 3500 },
		{ label: "3500-3999", max: 4000 },
		{ label: "4000-4999", max: 5000 },
		{ label: "5000+", max: Number.POSITIVE_INFINITY },
	]);

	return {
		rentHistogram,
		rentMeta: { avg: average(rentPrices), median: median(rentPrices) },
		oplatyHistogram,
		oplatyMeta: { avg: average(czynsz), median: median(czynsz) },
		totalHistogram,
		totalMeta: { avg: average(totals), median: median(totals) },
	};
}
