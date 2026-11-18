/**
 * Detects listings whose coordinates are a bulk-source placeholder rather
 * than a location.
 *
 * Several feeds publish a city but no coordinates, and the adapter or the
 * geocoder then writes the city centre: "Zamieszkaj wśród zieleni, Giszowiec"
 * landed exactly on the Katowice Rynek, a plot in Janczowa (a village 100 km
 * from Katowice) landed 20 m from the same point, and a Skotniki parcel
 * landed on the Kraków Rynek next to a cemetery plot and a "house in
 * Bulgaria". Downstream everything is then wrong: the comp set is the city
 * centre, the "centre zone" distance is 50 m, and a village plot is compared
 * with central building land (that produced a 94% "discount").
 *
 * Two independent signals, because placeholders arrive in two shapes:
 *
 * 1. A cluster: five or more *street-less, building-less, investment-less*
 *    sale listings within 25 m of each other. A city-centre fallback is shared
 *    by every listing that failed to geocode; a real address is not.
 * 2. An address-less pin within 400 m of a centre anchor. The anchors sit on
 *    market squares and street junctions, i.e. exactly where a fallback lands,
 *    while a real address there resolves to a footprint (or at least carries
 *    a street). This catches the single-listing case (the Janczowa village pin
 *    sat 330 m from the Katowice Rynek anchor).
 *
 * Clustering is done in memory over one query, with a neighbourhood check
 * rather than a grid-cell key: an exact key splits a ten-metre cluster that
 * straddles a cell border, which is how the Skotniki parcel escaped a
 * five-decimal match.
 */
import { and, isNotNull, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listings } from "#/db/schema";
import { nearestCentreAnchor } from "#/lib/scoring/centre-zone";

/** How many street-less listings must sit together before it is a placeholder. */
const CLUSTER_MIN = 5;

/** Cluster radius in metres. */
const CLUSTER_RADIUS_M = 25;

/** Grid cell used to find neighbours, degrees (about 22 m). */
const CELL_DEG = 0.0002;

/**
 * Radius around a centre anchor inside which an address-less pin is treated
 * as a placeholder. Every measured case sits inside it: the Katowice
 * placeholders 60-330 m from the Rynek anchor and the Skotniki parcel 770 m
 * from the Kraków one (its pin landed on the Teatr Słowackiego junction).
 * Streets around a market square are dense, so a real offer there carries an
 * address or a matched footprint; the rule only fires when neither exists.
 */
const ANCHOR_PLACEHOLDER_M = 900;

interface Candidate {
	id: number;
	lat: number;
	lng: number;
}

export interface PlaceholderIndex {
	/** Listing ids whose coordinates are a shared cluster. */
	ids: ReadonlySet<number>;
	/** Every candidate point, so the anchor rule needs no second query. */
	candidates: readonly Candidate[];
}

let cache: Promise<PlaceholderIndex> | null = null;

function metresBetween(a: Candidate, b: Candidate): number {
	const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
	const dx = (b.lng - a.lng) * 111_320 * Math.cos(meanLat);
	const dy = (b.lat - a.lat) * 110_574;
	return Math.hypot(dx, dy);
}

function cellKey(lat: number, lng: number): string {
	return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
}

/**
 * Cluster the candidates. A point joins a cluster when it lies within
 * `CLUSTER_RADIUS_M` of any member, so a chain of nearby points still counts
 * as one cluster; only the points that have at least `CLUSTER_MIN` neighbours
 * (including themselves) are marked.
 */
function clusterIds(candidates: readonly Candidate[]): Set<number> {
	const cells = new Map<string, Candidate[]>();
	for (const candidate of candidates) {
		const key = cellKey(candidate.lat, candidate.lng);
		const bucket = cells.get(key) ?? [];
		bucket.push(candidate);
		cells.set(key, bucket);
	}
	const neighbourCount = new Map<number, number>();
	for (const candidate of candidates) {
		const cy = Math.floor(candidate.lat / CELL_DEG);
		const cx = Math.floor(candidate.lng / CELL_DEG);
		let count = 0;
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				for (const other of cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
					if (metresBetween(candidate, other) <= CLUSTER_RADIUS_M) count++;
				}
			}
		}
		neighbourCount.set(candidate.id, count);
	}
	const marked = new Set<number>();
	for (const [id, count] of neighbourCount) {
		if (count >= CLUSTER_MIN) marked.add(id);
	}
	return marked;
}

/**
 * Build the placeholder index: one query for every street-less, building-less,
 * investment-less sale listing, then in-memory clustering. Cached for the
 * process; `clearPlaceholderCache()` makes a fresh crawl visible.
 */
export function loadPlaceholderPoints(): Promise<PlaceholderIndex> {
	if (cache) return cache;
	cache = (async () => {
		// A development's pin is its own place (`investmentId` is set on every
		// unit row) and several units legitimately share it, so those rows are
		// out of the count: they are grouped by investment, not by address.
		const rows = await db
			.select({
				id: listings.id,
				lat: sql<number>`${listings.lat}`,
				lng: sql<number>`${listings.lng}`,
			})
			.from(listings)
			.where(
				and(
					isNotNull(listings.lat),
					isNotNull(listings.lng),
					sql`${listings.street} is null`,
					sql`${listings.buildingId} is null`,
					sql`${listings.investmentId} is null`,
					sql`${listings.offerType} = 'sale'`,
				),
			);
		const candidates: Candidate[] = [];
		for (const row of rows) {
			const lat = Number(row.lat);
			const lng = Number(row.lng);
			if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
			candidates.push({ id: row.id, lat, lng });
		}
		return { ids: clusterIds(candidates), candidates };
	})();
	return cache;
}

export interface PlaceholderCandidate {
	id: number;
	lat: number | null;
	lng: number | null;
	city?: string | null;
	street: string | null;
	buildingId: number | null;
	/** Set on every unit row of a development; its pin is the investment's own. */
	investmentId?: string | null;
}

/** True when the listing's coordinates are a shared placeholder cluster. */
export function isClusterPlaceholder(
	index: PlaceholderIndex,
	id: number,
): boolean {
	return index.ids.has(id);
}

/**
 * True when the listing has no location evidence beyond a city centre, either
 * because it belongs to a cluster of street-less pins or because its pin sits
 * on a centre anchor without an address and without a matched footprint.
 */
export function isPlaceholderListing(
	index: PlaceholderIndex,
	row: PlaceholderCandidate,
): boolean {
	if (isClusterPlaceholder(index, row.id)) return true;
	if (row.street != null && row.street.trim() !== "") return false;
	if (row.buildingId != null) return false;
	// An investment pin is the development's own location, not a fallback.
	if (row.investmentId != null && row.investmentId !== "") return false;
	if (row.lat == null || row.lng == null) return false;
	// No city filter on purpose: `nearestCentreAnchor` falls back to every
	// anchor when the listing's town has none, and a village pin that lands on
	// a city square is precisely the case this must catch.
	const anchor = nearestCentreAnchor(row.lat, row.lng, null);
	return anchor != null && anchor.distanceM <= ANCHOR_PLACEHOLDER_M;
}

/** Drop the cache; called at the start of a scoring run. */
export function clearPlaceholderCache(): void {
	cache = null;
}
