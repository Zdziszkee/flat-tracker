import type { CheerioAdapter, Listing } from "../types.ts";

/**
 * Airbnb short-term rental search results for Małopolska (bounding box).
 *
 * Airbnb's search HTML embeds the full result payload in
 * `<script id="data-deferred-state-0" type="application/json">` (no browser
 * required). Each `StaySearchResult` carries the listing title, rating,
 * coordinates and a structured total price for a default stay; the nightly
 * asking rate is recovered from the price breakdown line ("5 nocy x 929 zł").
 *
 * Exact street addresses are hidden by Airbnb until booking, so listings are
 * anchored by coordinates and district-level analytics only.
 */

const SEARCH_URL =
	"https://www.airbnb.pl/s/Lesser-Poland-Voivodeship--Poland/homes?adults=1&refinement_paths%5B%5D=%2Fhomes&place_id=ChIJXe0Xc18WFkcRcMDkxa18AQE&query=Lesser%20Poland%20Voivodeship%2C%20Poland&flexible_trip_lengths%5B%5D=one_week&monthly_start_date=2026-09-01&monthly_length=3&monthly_end_date=2026-12-01&search_mode=regular_search&price_filter_input_type=2&channel=EXPLORE&ne_lat=51.32727302353554&ne_lng=23.143675988176255&sw_lat=48.41323651378321&sw_lng=18.360351146270887&zoom=8.73265530645283&zoom_level=8.73265530645283&search_by_map=true&search_type=user_map_move";

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
		url: listingId ? `https://www.airbnb.pl/rooms/${listingId}` : SEARCH_URL,
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
	startUrls: [SEARCH_URL],
	maxRequestsPerCrawl: 30,

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

		if (pageCursors.length > 1) {
			const current = new URL(url).searchParams.get("cursor") ?? null;
			const currentIndex = current ? pageCursors.indexOf(current) : 0;
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
