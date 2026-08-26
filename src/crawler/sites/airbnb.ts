import type { CheerioAdapter, Listing } from "../types.ts";

/**
 * Airbnb short-term rental search results for Małopolska (sharded markets).
 *
 * Airbnb's search HTML embeds the full result payload in
 * `<script id="data-deferred-state-0" type="application/json">` (no browser
 * required). Each `StaySearchResult` carries the listing title, rating,
 * coordinates and a structured total price for a default stay; the nightly
 * asking rate is recovered from the price breakdown line ("5 nocy x 929 zł").
 *
 * A single Airbnb search session exposes only ~15 cursor pages (~18 cards
 * each), regardless of the true result count ("1000+" shown in the UI).
 * Crawling one region-wide box therefore tops out near ~250 listings. To
 * get past that ceiling the region is split into overlapping per-market
 * bounding boxes: every shard paginates its own cursor chain, and duplicate
 * listings collapse in the DB upsert on `(source, externalId)`.
 *
 * Exact street addresses are hidden by Airbnb until booking, so listings are
 * anchored by coordinates and district-level analytics only.
 */

/** One search shard: an approximate bounding box over a rental market. */
interface MarketShard {
	name: string;
	neLat: number;
	neLng: number;
	swLat: number;
	swLng: number;
}

/**
 * Overlapping boxes tiling Małopolska's short-term rental supply: Kraków,
 * the Tatry/Podhale winter belt, the Poprad valley spa towns, plus the
 * smaller western/northern/eastern markets.
 */
const MARKET_SHARDS: MarketShard[] = [
	{ name: "krakow", neLat: 50.25, neLng: 20.25, swLat: 49.95, swLng: 19.75 },
	{
		name: "wieliczka-bochnia",
		neLat: 50.08,
		neLng: 20.65,
		swLat: 49.88,
		swLng: 20.0,
	},
	{
		name: "tatry-podhale",
		neLat: 49.45,
		neLng: 20.3,
		swLat: 49.2,
		swLng: 19.75,
	},
	{
		name: "pieniny-poprad",
		neLat: 49.6,
		neLng: 21.0,
		swLat: 49.32,
		swLng: 20.3,
	},
	{ name: "sadecki", neLat: 49.85, neLng: 20.95, swLat: 49.5, swLng: 20.4 },
	{
		name: "oswiecim-chrzanow",
		neLat: 50.18,
		neLng: 19.55,
		swLat: 49.9,
		swLng: 19.05,
	},
	{
		name: "olkusz-miechow",
		neLat: 50.52,
		neLng: 20.35,
		swLat: 50.15,
		swLng: 19.4,
	},
	{
		name: "tarnow-dabrowskie",
		neLat: 50.35,
		neLng: 21.42,
		swLat: 49.95,
		swLng: 20.6,
	},
];

function shardSearchUrl(s: MarketShard): string {
	const params = new URLSearchParams({
		adults: "2",
		"refinement_paths[]": "/homes",
		query: "Lesser Poland Voivodeship, Poland",
		search_mode: "regular_search",
		search_by_map: "true",
		ne_lat: String(s.neLat),
		ne_lng: String(s.neLng),
		sw_lat: String(s.swLat),
		sw_lng: String(s.swLng),
		zoom: "10",
	});
	return `https://www.airbnb.pl/s/${encodeURIComponent(
		s.name,
	)}/homes?${params.toString()}`;
}

interface Coordinate {
	latitude?: number;
	longitude?: number;
}

interface StaySearchResult {
	__typename?: string;
	title?: string;
	subtitle?: string;
	avgRatingLocalized?: string;
	structuredDisplayPrice?: {
		primaryLine?: { accessibilityLabel?: string };
		explanationData?: {
			priceDetails?: Array<{
				items?: Array<{ description?: string; priceString?: string }>;
			}>;
		};
	};
	demandStayListing?: {
		id?: string;
		location?: { coordinate?: Coordinate };
	};
}

function findSearchResults(node: unknown): StaySearchResult[] | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const v of node) {
			const r = findSearchResults(v);
			if (r) return r;
		}
		return null;
	}
	const obj = node as Record<string, unknown>;
	if (obj.searchResults && Array.isArray(obj.searchResults)) {
		return obj.searchResults as StaySearchResult[];
	}
	for (const v of Object.values(obj)) {
		const r = findSearchResults(v);
		if (r) return r;
	}
	return null;
}

function decodeListingId(base64: string | undefined): string | null {
	if (!base64) return null;
	try {
		const decoded = Buffer.from(base64, "base64").toString("utf8");
		const idx = decoded.lastIndexOf(":");
		return idx >= 0 ? decoded.slice(idx + 1) : decoded;
	} catch {
		return null;
	}
}

/** Parse "5 nocy x 929,00 zł" -> 929. */
function parseNightlyRate(desc: string | undefined): number | null {
	if (!desc) return null;
	const m = desc.match(/x\s*([\d\s.,]+)/i);
	if (!m) return null;
	const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse "4,98 (49)" -> { rating: 4.98, reviews: 49 }. */
function parseRating(localized: string | undefined): {
	rating: number | null;
	reviews: number | null;
} {
	if (!localized) return { rating: null, reviews: null };
	const m = localized.match(/([\d,]+)\s*\((\d+)\)/);
	if (!m) return { rating: null, reviews: null };
	const rating = Number(m[1].replace(",", "."));
	const reviews = Number(m[2]);
	return {
		rating: Number.isFinite(rating) ? rating : null,
		reviews: Number.isFinite(reviews) ? reviews : null,
	};
}

function resultToListing(r: StaySearchResult): Listing {
	const listingId = decodeListingId(r.demandStayListing?.id);
	const rawId = r.demandStayListing?.id ?? "";
	const { rating, reviews } = parseRating(r.avgRatingLocalized);
	const priceDetail = r.structuredDisplayPrice?.explanationData?.priceDetails;
	const nightlyLine = priceDetail
		?.flatMap((p) => p.items ?? [])
		.find((i) => i.description && /nocy\s*x/i.test(i.description));
	const price = parseNightlyRate(nightlyLine?.description);
	const lat = r.demandStayListing?.location?.coordinate?.latitude ?? null;
	const lng = r.demandStayListing?.location?.coordinate?.longitude ?? null;

	return {
		source: "airbnb",
		externalId: listingId ?? r.demandStayListing?.id ?? "",
		url:
			listingId || rawId
				? `https://www.airbnb.pl/rooms/${listingId || rawId}`
				: "",
		title: r.subtitle ?? r.title ?? "Airbnb listing",
		price,
		pricePerM2: null,
		areaM2: null,
		rooms: null,
		floor: null,
		district: null,
		address: null,
		description: null,
		heatingType: null,
		propertyType: null,
		features: JSON.stringify({
			avgRatingLocalized: r.avgRatingLocalized ?? null,
			priceDetail: priceDetail ?? null,
		}),
		lat: lat && lng ? lat : null,
		lng: lat && lng ? lng : null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
		offerType: "short_term_rental",
		pricePeriod: "night",
		rating,
		reviewsCount: reviews,
	};
}

export const airbnbAdapter: CheerioAdapter = {
	id: "airbnb",
	name: "Airbnb - Małopolska short-term rentals",
	kind: "cheerio",
	startUrls: MARKET_SHARDS.map((s) => shardSearchUrl(s)),
	// Each shard walks its own ~15-page cursor chain.
	maxRequestsPerCrawl: MARKET_SHARDS.length * 20,
	// Airbnb rankings are not newest-first, so a first-page-only hourly run
	// would see nothing new past shard #1 (crawler.ts caps it at 1 request).
	// Always walk every shard; ~120 light JSON-in-HTML fetches per run.
	alwaysFullCrawl: true,

	async extractHtml(html, url, enqueue) {
		const match = html.match(
			/<script id="data-deferred-state-0"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
		);
		if (!match) return [];
		let data: unknown;
		try {
			data = JSON.parse(match[1]);
		} catch {
			return [];
		}

		const results = findSearchResults(data) ?? [];

		// Pagination is a base64 cursor list; enqueue the next page once.
		// Page 1 (no `cursor` param) continues at cursors[0].
		const pageCursors = (() => {
			const walk = (n: unknown): string[] | null => {
				if (!n || typeof n !== "object") return null;
				if (Array.isArray(n)) {
					for (const v of n) {
						const r = walk(v);
						if (r) return r;
					}
					return null;
				}
				const o = n as Record<string, unknown>;
				if (Array.isArray(o.pageCursors)) return o.pageCursors as string[];
				for (const v of Object.values(o)) {
					const r = walk(v);
					if (r) return r;
				}
				return null;
			};
			return walk(data) ?? [];
		})();

		if (pageCursors.length > 0) {
			const current = new URL(url).searchParams.get("cursor") ?? null;
			const currentIndex = current ? pageCursors.indexOf(current) : -1;
			const next = pageCursors[currentIndex + 1];
			if (next) {
				const base = new URL(url);
				base.searchParams.set("cursor", next);
				await enqueue([base.toString()]);
			}
		}

		return results.map(resultToListing);
	},
};
