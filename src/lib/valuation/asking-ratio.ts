/**
 * Asking-to-transaction conversion for listing-sourced comparables.
 *
 * A portal listing is an asking price, and asking prices clear below their
 * face value. The valuation model uses active listings only when fewer than
 * three RCN transactions survive, so leaving them at face value quietly
 * inflates every fallback estimate. Instead of hardcoding a guess, this module
 * measures the gap from our own corpus: the median asking zł/m² of visible
 * sale listings against the median RCN zł/m² of recorded transactions in the
 * same region and quarter. Buckets with too few observations fall back to a
 * conservative constant.
 *
 * Research behind the fallbacks (2026-11):
 *   - flats: NBP BaRN gap ~9% in Kraków and ~8.7% in Katowice; a 2026 market
 *     study puts the asking/transaction gap at 9% (Katowice) to 17.2%
 *     (Gdańsk), while a single negotiated deal gives up 2.2% (Kraków) to
 *     5.4% (Łódź). The gap between stock medians is the relevant one here
 *     (we compare median listing to median transaction), so 0.96 is the
 *     conservative end of the published range.
 *     https://ilezametr.pl/cena-ofertowa-a-transakcyjna-mieszkan-2026-luka-negocjacyjna
 *     https://bknieruchomosci.pl/coraz-wieksza-roznica-miedzy-cenami-ofertowymi-a-transakcyjnymi-mieszkan
 *   - houses: comparative valuation examples apply a 5-10% offer/deed
 *     correction; 0.95 is the soft end.
 *     https://immohouse.pl/blog/poradnik-sprzedajacego/wycena-domu-kalkulator-metoda-porownawcza-i-kosztowa-krok-po-kroku
 *   - plots: 3-10% typical (dzialkopedia.pl), with local outliers far
 *     higher (21.7% in one gmina). There is no region-wide published figure,
 *     so 0.90 stays conservative.
 *     https://dzialkopedia.pl/poradnik/ceny-i-wycena/cena-transakcyjna-a-ofertowa
 *
 * Read-only, DB-backed, cached in-process. Every query is bounded to the
 * tracked regions (`inTrackedRegions` / the same coordinate boxes for the
 * listings table, which has no generated region column).
 */

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import {
	inTrackedRegions,
	TRACKED_REGION_IDS,
	TRACKED_REGIONS,
} from "#/db/region";
import { weightedQuantile } from "#/lib/stats";
import type { QualitySegment } from "#/lib/valuation/quality-factor";

export interface AskingRatio {
	segment: QualitySegment;
	/** Region id, or "tracked" when both voivodeships were pooled. */
	region: string;
	ratio: number;
	sampleListings: number;
	sampleTransactions: number;
	source: "measured" | "fallback";
}

export interface AskingRatioBucket {
	segment: QualitySegment;
	region: string;
	quarter: string;
	listingMedian: number;
	transactionMedian: number;
	ratio: number;
	sampleListings: number;
	sampleTransactions: number;
	/** False when a side of the bucket was too thin to use. */
	used: boolean;
}

/** Conservative fallbacks, used only when a measured bucket is too thin. */
export const ASKING_RATIO_FALLBACK: Record<QualitySegment, number> = {
	flat: 0.96,
	house: 0.95,
	plot: 0.9,
};

/** Minimum observations on each side of a usable quarter bucket. */
export const ASKING_RATIO_MIN_SAMPLE = 50;
/** Lookback window for the measurement, quarters. */
export const ASKING_RATIO_LOOKBACK_QUARTERS = 8;
/**
 * A measured ratio outside this band is treated as period contamination, not
 * as a discount. The upper bound is 1.0 on purpose: the stock median may sit
 * above a *partial* quarter's deed median (the latest RCN quarter lags), but
 * an asking price is never converted upward for a valuation comp. A bucket
 * that needs an increase is discarded and the fallback is used.
 */
const RATIO_SANITY_MIN = 0.7;
const RATIO_SANITY_MAX = 1.0;

const SEGMENT_KIND: Record<
	QualitySegment,
	{
		listingKind: string;
		transactionKind: string;
		minM2: number;
		maxM2: number;
		/** Registry rows with a lower median are not a usable price level. */
		minTransactionMedian: number;
	}
> = {
	flat: {
		listingKind: "apartment",
		transactionKind: "unit",
		minM2: 500,
		maxM2: 60000,
		minTransactionMedian: 1000,
	},
	house: {
		listingKind: "house",
		transactionKind: "building",
		minM2: 100,
		maxM2: 40000,
		minTransactionMedian: 500,
	},
	plot: {
		listingKind: "plot",
		transactionKind: "parcel",
		minM2: 0.01,
		maxM2: 20000,
		minTransactionMedian: 10,
	},
};

/** The generated `transactions.region` twin, applied to listing coordinates. */
const LISTING_REGION_CASE_SQL = `case ${TRACKED_REGION_IDS.map((id) => {
	const box = TRACKED_REGIONS[id];
	const lat = `coalesce(map_lat, lat) between ${box.minLat} and ${box.maxLat}`;
	const lng = `coalesce(map_lng, lng) between ${box.minLng} and ${box.maxLng}`;
	return `when (${lat} and ${lng}) then '${id}'`;
}).join(" ")} end`;

const QUARTER_SQL = (column: string) =>
	`strftime('%Y', ${column}, 'unixepoch') || '-Q' || ((cast(strftime('%m', ${column}, 'unixepoch') as integer) + 2) / 3)`;

interface PriceRow {
	region: string;
	quarter: string;
	pricePerM2: number;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? null;
	const a = sorted[mid - 1];
	const b = sorted[mid];
	return a == null || b == null ? null : (a + b) / 2;
}

async function listingPrices(
	segment: QualitySegment,
	region: string | null,
): Promise<PriceRow[]> {
	const kind = SEGMENT_KIND[segment];
	const regionFilter =
		region == null ? "" : `and region = '${region.replace(/'/gu, "''")}'`;
	return db.all<PriceRow>(sql`
		with base as (
			select ${sql.raw(LISTING_REGION_CASE_SQL)} as region,
				${sql.raw(QUARTER_SQL("cast(coalesce(listed_at, first_seen_at) as integer)"))} as quarter,
				pricePerM2 as pricePerM2
			from listings
			where offer_type = 'sale'
				and is_visible = 1
				and property_kind = ${kind.listingKind}
				and pricePerM2 between ${kind.minM2} and ${kind.maxM2}
				and coalesce(listed_at, first_seen_at) is not null
				and coalesce(listed_at, first_seen_at) >= unixepoch('now', ${`-${(ASKING_RATIO_LOOKBACK_QUARTERS + 1) * 3} months`})
		)
		select region, quarter, pricePerM2
		from base
		where region is not null ${sql.raw(regionFilter)}
	`);
}

async function transactionPrices(
	segment: QualitySegment,
	region: string | null,
): Promise<PriceRow[]> {
	const kind = SEGMENT_KIND[segment];
	const regionFilter =
		region == null ? "" : `and region = '${region.replace(/'/gu, "''")}'`;
	return db.all<PriceRow>(sql`
		select region,
			${sql.raw(QUARTER_SQL("date"))} as quarter,
			pricePerM2 as pricePerM2
		from transactions
		where ${inTrackedRegions}
			and kind = ${kind.transactionKind}
			and pricePerM2 between ${kind.minM2} and ${kind.maxM2}
			and date >= unixepoch('now', ${`-${(ASKING_RATIO_LOOKBACK_QUARTERS + 1) * 3} months`})
			and date <= unixepoch('now')
			${sql.raw(regionFilter)}
	`);
}

function bucketize(
	rows: readonly PriceRow[],
): Map<string, Map<string, number[]>> {
	const out = new Map<string, Map<string, number[]>>();
	for (const row of rows) {
		if (!row.region || !row.quarter) continue;
		let byRegion = out.get(row.region);
		if (!byRegion) {
			byRegion = new Map();
			out.set(row.region, byRegion);
		}
		const values = byRegion.get(row.quarter) ?? [];
		values.push(row.pricePerM2);
		byRegion.set(row.quarter, values);
	}
	return out;
}

/**
 * Measure every region/quarter bucket for one segment. Exported for the audit
 * script; the model itself only needs `askingToTransactionRatio`.
 */
export async function measureAskingRatioBuckets(
	segment: QualitySegment,
): Promise<AskingRatioBucket[]> {
	const [listings, transactions] = await Promise.all([
		listingPrices(segment, null),
		transactionPrices(segment, null),
	]);
	const listingBuckets = bucketize(listings);
	const transactionBuckets = bucketize(transactions);
	const regions = new Set([
		...listingBuckets.keys(),
		...transactionBuckets.keys(),
	]);
	const buckets: AskingRatioBucket[] = [];
	for (const region of regions) {
		const byQuarter = new Map<
			string,
			{ listing: number[]; transaction: number[] }
		>();
		for (const quarter of listingBuckets.get(region)?.keys() ?? []) {
			const entry = byQuarter.get(quarter) ?? {
				listing: [],
				transaction: [],
			};
			entry.listing = listingBuckets.get(region)?.get(quarter) ?? [];
			byQuarter.set(quarter, entry);
		}
		for (const quarter of transactionBuckets.get(region)?.keys() ?? []) {
			const entry = byQuarter.get(quarter) ?? {
				listing: [],
				transaction: [],
			};
			entry.transaction = transactionBuckets.get(region)?.get(quarter) ?? [];
			byQuarter.set(quarter, entry);
		}
		for (const [quarter, entry] of byQuarter) {
			const listingMedian = median(entry.listing);
			const transactionMedian = median(entry.transaction);
			if (listingMedian == null || transactionMedian == null) continue;
			const ratio = listingMedian / transactionMedian;
			const used =
				entry.listing.length >= ASKING_RATIO_MIN_SAMPLE &&
				entry.transaction.length >= ASKING_RATIO_MIN_SAMPLE &&
				transactionMedian >= SEGMENT_KIND[segment].minTransactionMedian &&
				ratio >= RATIO_SANITY_MIN &&
				ratio <= RATIO_SANITY_MAX;
			buckets.push({
				segment,
				region,
				quarter,
				listingMedian,
				transactionMedian,
				ratio,
				sampleListings: entry.listing.length,
				sampleTransactions: entry.transaction.length,
				used,
			});
		}
	}
	return buckets.sort(
		(a, b) =>
			a.region.localeCompare(b.region) || b.quarter.localeCompare(a.quarter),
	);
}

function clampMeasuredRatio(value: number): number {
	return Math.min(RATIO_SANITY_MAX, Math.max(RATIO_SANITY_MIN, value));
}

function combineBuckets(
	buckets: readonly AskingRatioBucket[],
	segment: QualitySegment,
	region: string,
): AskingRatio {
	const usable = buckets.filter(
		(bucket) =>
			bucket.used && (region === "tracked" || bucket.region === region),
	);
	if (usable.length === 0) {
		return {
			segment,
			region,
			ratio: ASKING_RATIO_FALLBACK[segment],
			sampleListings: 0,
			sampleTransactions: 0,
			source: "fallback",
		};
	}
	const weighted = usable.map((bucket) => ({
		value: bucket.ratio,
		weight: Math.min(bucket.sampleListings, bucket.sampleTransactions),
	}));
	const ratio = clampMeasuredRatio(
		weightedQuantile(weighted, 0.5) ?? ASKING_RATIO_FALLBACK[segment],
	);
	return {
		segment,
		region,
		ratio: Math.round(ratio * 1000) / 1000,
		sampleListings: usable.reduce(
			(sum, bucket) => sum + bucket.sampleListings,
			0,
		),
		sampleTransactions: usable.reduce(
			(sum, bucket) => sum + bucket.sampleTransactions,
			0,
		),
		source: "measured",
	};
}

const cache = new Map<string, Promise<AskingRatio>>();

/** Drop the in-process cache (tests, or after a bulk import). */
export function resetAskingRatioCache(): void {
	cache.clear();
}

/**
 * Asking-to-transaction ratio for one segment and region, or the pooled
 * "tracked" ratio when `region` is null. Cached per process.
 */
export async function askingToTransactionRatio(
	segment: QualitySegment,
	region: string | null,
): Promise<AskingRatio> {
	const regionKey = region ?? "tracked";
	const key = `${segment}|${regionKey}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const promise = (async () => {
		const buckets = await measureAskingRatioBuckets(segment);
		return combineBuckets(buckets, segment, regionKey);
	})();
	cache.set(key, promise);
	try {
		return await promise;
	} catch (error) {
		cache.delete(key);
		throw error;
	}
}
