/**
 * Data behind the holiday-house target.
 *
 * A house alert is now a bet on a unique property that earns from short-term
 * rentals, not on spare building land. Two signals decide it, and both come
 * from data we already hold:
 *
 * - **Isolation**: how far the nearest other building stands and how many
 *   buildings sit inside 150 m, from the local `osm_buildings` index (the same
 *   3.2M footprints the map renders). A house with a neighbour 12 m away is
 *   not the thing the target is about, whatever the ad says.
 * - **STR market**: the median nightly price of the short-term rentals around
 *   it, from the airbnb/booking rows the crawler already stores, which turns
 *   "good for Airbnb" into a number a buyer can check.
 *
 * Both are DB reads, so they happen in the scoring run (and are cached per
 * grid cell) and travel into `scoreAlert` as plain values: the score itself
 * stays a pure function.
 */
import { and, gte, isNotNull, lte, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listings, osmBuildings } from "#/db/schema";

/** Metres per degree of latitude, for the bbox pre-filter. */
const METRES_PER_DEGREE = 111_320;

/** Radius searched around a house for other buildings. */
const NEIGHBOUR_RADIUS_M = 300;

/** Buildings closer than this are the house itself (its own footprint). */
const SELF_FOOTPRINT_M = 20;

/** Neighbours counted as "next door". */
const CLOSE_NEIGHBOUR_M = 150;

/** Radius for the short-term-rental market sample. */
const STR_RADIUS_M = 2000;

export interface Neighbourhood {
	/** Distance to the nearest other building, metres (null when none). */
	nearestBuildingM: number | null;
	/** Other buildings within 150 m. */
	buildingsWithin150m: number;
	/** Footprints found in the 300 m bbox (context for the count). */
	sampledBuildings: number;
}

export interface StrMarket {
	/** Median nightly price of nearby short-term rentals, PLN. */
	nightlyMedian: number | null;
	/** How many priced rentals the median is built from. */
	sampleCount: number;
	/** Cheapest and dearest nightly price in the same sample. */
	nightlyLow: number | null;
	nightlyHigh: number | null;
}

const neighbourhoodCache = new Map<string, Promise<Neighbourhood>>();
const strCache = new Map<string, Promise<StrMarket>>();

/** 250 m cache cell: houses in the same estate share one query. */
function cellKey(lat: number, lng: number): string {
	return `${lat.toFixed(2)}:${lng.toFixed(2)}`;
}

function haversineM(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number,
): number {
	const phi1 = (lat1 * Math.PI) / 180;
	const phi2 = (lat2 * Math.PI) / 180;
	const dPhi = phi2 - phi1;
	const dLambda = ((lng2 - lng1) * Math.PI) / 180;
	const a =
		Math.sin(dPhi / 2) ** 2 +
		Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Nearest other building and the number within 150 m.
 *
 * The query rides `osm_buildings_bbox_idx`; a 300 m box around a suburban
 * house holds a few hundred footprints, and the cell cache means a street of
 * offers costs one query. Values are cached even when the answer is "nothing
 * found", so a lone house in a forest is not re-queried.
 */
export function neighbourhoodAt(
	lat: number | null | undefined,
	lng: number | null | undefined,
): Promise<Neighbourhood> {
	const empty: Neighbourhood = {
		nearestBuildingM: null,
		buildingsWithin150m: 0,
		sampledBuildings: 0,
	};
	if (lat == null || lng == null) return Promise.resolve(empty);
	const key = cellKey(lat, lng);
	const cached = neighbourhoodCache.get(key);
	if (cached) return cached;
	const promise = (async () => {
		const dLat = NEIGHBOUR_RADIUS_M / METRES_PER_DEGREE;
		const dLng =
			NEIGHBOUR_RADIUS_M /
			(METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
		const rows = await db
			.select({
				lat: osmBuildings.centroidLat,
				lng: osmBuildings.centroidLng,
			})
			.from(osmBuildings)
			.where(
				and(
					gte(osmBuildings.bboxMaxLat, lat - dLat),
					lte(osmBuildings.bboxMinLat, lat + dLat),
					gte(osmBuildings.bboxMaxLng, lng - dLng),
					lte(osmBuildings.bboxMinLng, lng + dLng),
				),
			);
		let nearest: number | null = null;
		let close = 0;
		for (const row of rows) {
			const distance = haversineM(lat, lng, row.lat, row.lng);
			if (distance <= SELF_FOOTPRINT_M) continue;
			if (distance <= CLOSE_NEIGHBOUR_M) close++;
			if (nearest == null || distance < nearest) nearest = distance;
		}
		return {
			nearestBuildingM: nearest,
			buildingsWithin150m: close,
			sampledBuildings: rows.length,
		};
	})();
	neighbourhoodCache.set(key, promise);
	return promise;
}

/** Median of a numeric list; an empty list yields null. */
function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[middle - 1] + sorted[middle]) / 2
		: sorted[middle];
}

/**
 * Nightly-price market around a point, from the stored short-term rentals.
 * A sample under three offers is reported as-is (with its count) rather than
 * smoothed into a fake median: the score refuses to credit it.
 */
export function strMarketAt(
	lat: number | null | undefined,
	lng: number | null | undefined,
): Promise<StrMarket> {
	const empty: StrMarket = {
		nightlyMedian: null,
		sampleCount: 0,
		nightlyLow: null,
		nightlyHigh: null,
	};
	if (lat == null || lng == null) return Promise.resolve(empty);
	const key = cellKey(lat, lng);
	const cached = strCache.get(key);
	if (cached) return cached;
	const promise = (async () => {
		const dLat = STR_RADIUS_M / METRES_PER_DEGREE;
		const dLng =
			STR_RADIUS_M / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
		const rows = await db
			.select({ price: listings.price })
			.from(listings)
			.where(
				and(
					sql`${listings.offerType} = 'short_term_rental'`,
					sql`${listings.isVisible} = 1`,
					isNotNull(listings.price),
					sql`${listings.price} > 0`,
					gte(listings.lat, lat - dLat),
					lte(listings.lat, lat + dLat),
					gte(listings.lng, lng - dLng),
					lte(listings.lng, lng + dLng),
				),
			);
		const prices = rows
			.map((row) => row.price ?? 0)
			.filter((price) => price > 0);
		return {
			nightlyMedian: median(prices),
			sampleCount: prices.length,
			nightlyLow: prices.length > 0 ? Math.min(...prices) : null,
			nightlyHigh: prices.length > 0 ? Math.max(...prices) : null,
		};
	})();
	strCache.set(key, promise);
	return promise;
}

/** Drop both caches. Called at the start of a scoring run. */
export function clearHouseNatureCache(): void {
	neighbourhoodCache.clear();
	strCache.clear();
}
