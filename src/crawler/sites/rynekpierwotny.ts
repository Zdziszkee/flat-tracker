import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REGIONS, regionForPoint } from "../regions.ts";
import type { CheerioAdapter, Listing } from "../types.ts";
import { num, str } from "./ldoffer.ts";

/**
 * The list state omits the posting date; the detail page's
 * `offerDetail.offer.configuration.publish_date` (falling back to its
 * `create_date`) is the authoritative "data dodania". A small persistent
 * detail pass fills the backlog without crowding out list pagination.
 */
const DETAIL_BUDGET_PER_PAGE = 3;

interface CachedOffer {
	listedAt: string | null;
	fetchedAt: string;
}

let offerCacheState: Record<string, CachedOffer> | null = null;

function offerCachePath(): string {
	return (
		process.env.RYNEKPIERWOTNY_OFFER_CACHE ??
		"data/crawler/rynekpierwotny-offers.json"
	);
}

function loadOfferCache(): Record<string, CachedOffer> {
	if (offerCacheState) return offerCacheState;
	let parsed: Record<string, Partial<CachedOffer>> = {};
	try {
		parsed = JSON.parse(readFileSync(offerCachePath(), "utf8"));
	} catch {
		// Missing or corrupt cache: start empty, details simply re-fetch.
	}
	const cache: Record<string, CachedOffer> = {};
	for (const [id, entry] of Object.entries(parsed)) {
		cache[id] = {
			listedAt: entry.listedAt ?? null,
			fetchedAt: entry.fetchedAt ?? "",
		};
	}
	offerCacheState = cache;
	return cache;
}

function saveOfferCache(cache: Record<string, CachedOffer>): void {
	const path = offerCachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cache));
}

/**
 * Rynekpierwotny lists new-development projects (osiedla), not individual
 * flats. The page state lives in window.__INITIAL_STATE__ (offerList.list.
 * offers); each offer carries a geo point, price/area ranges for its units
 * and the number of flats for sale. We store the project with its minimum
 * unit price/area as representative values.
 */
export const rynekpierwotnyAdapter: CheerioAdapter = {
	id: "rynekpierwotny",
	name: "Rynekpierwotny - Małopolska + Śląsk new developments",
	kind: "cheerio",
	// sort=2 orders the list newest-first, so a bounded crawl always
	// starts with the freshest investments. One list per property kind per
	// covered voivodeship; each paginates through its own state `next` link.
	startUrls: REGIONS.flatMap((r) => [
		`https://rynekpierwotny.pl/s/nowe-mieszkania-${r.name}/?sort=2`,
		`https://rynekpierwotny.pl/s/nowe-domy-${r.name}/?sort=2`,
	]),
	maxRequestsPerCrawl: 80,
	// One newest page per kind and region plus a few detail pages.
	firstPageOnlyRequests: REGIONS.length * 2 * (1 + DETAIL_BUDGET_PER_PAGE),

	async extractHtml(html, url, enqueue) {
		const state = parseInitialState(html);
		const detailOffer = state?.offerDetail?.offer;
		if (/\/oferty\//u.test(url) && detailOffer) {
			const listing = offerToListing(detailOffer, url);
			if (!listing) return [];
			const listedAt = detailListedAt(detailOffer);
			listing.listedAt = listedAt;
			const cache = loadOfferCache();
			cache[listing.externalId] = {
				listedAt,
				fetchedAt: new Date().toISOString(),
			};
			saveOfferCache(cache);
			return [listing];
		}

		const offers = state?.offerList?.list?.offers ?? [];

		const listings: Listing[] = [];
		for (const offer of offers) {
			const listing = offerToListing(offer);
			if (listing) listings.push(listing);
		}
		const cache = loadOfferCache();
		const detailUrls: string[] = [];
		for (const listing of listings) {
			const cached = cache[listing.externalId];
			if (cached) {
				if (!listing.listedAt) listing.listedAt = cached.listedAt;
				continue;
			}
			if (detailUrls.length < DETAIL_BUDGET_PER_PAGE && listing.url) {
				detailUrls.push(listing.url);
			}
		}
		if (detailUrls.length > 0) await enqueue(detailUrls);

		// Follow the canonical "next" link until the list is exhausted
		// (count/page_size bounds it; the page state is authoritative).
		// First-page-only runs stop here; their request cap is the detail budget.
		const pageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
		if (!pageOnly) {
			const list = state?.offerList?.list;
			const page = list?.page ?? 1;
			const pageSize = list?.page_size ?? offers.length;
			const count = list?.count ?? 0;
			const next = state?.metaData?.standardMetaData?.next;
			if (typeof next === "string" && next && page * pageSize < count) {
				await enqueue([next.replaceAll("&amp;", "&")]);
			}
		}

		return listings;
	},
};

interface RpState {
	offerList?: {
		list?: {
			offers?: RpOffer[];
			page?: number;
			page_size?: number;
			count?: number;
		};
	};
	metaData?: {
		standardMetaData?: {
			next?: string;
		};
	};
	offerDetail?: {
		offer?: RpOffer;
	};
}

interface RpOffer {
	id?: number;
	name?: string;
	slug?: string;
	address?: string;
	geo_point?: { coordinates?: number[] };
	region?: { district?: string; city?: string };
	street_name?: string;
	street_number?: string;
	stats?: {
		ranges_price_min?: number | string;
		ranges_price_m2_min?: number | string;
		ranges_area_min?: number | string;
	};
	groups?: {
		stages?: Array<{
			offer?: { vendor?: { slug?: string } };
		}>;
	};
	/** 1 = flat, 2 = house. */
	type?: number;
	/** Detail endpoint: publish date (null when the vendor hides it). */
	configuration?: {
		publish_date?: string;
		hide_publish_date?: boolean;
	};
	create_date?: string;
}

function parseInitialState(html: string): RpState | null {
	const i = html.indexOf("__INITIAL_STATE__");
	if (i < 0) return null;
	const eq = html.indexOf("=", i);
	if (eq < 0) return null;
	const raw = html.slice(eq + 1).trimStart();
	const json = extractBalancedObject(raw);
	if (!json) return null;
	try {
		return JSON.parse(json) as RpState;
	} catch {
		return null;
	}
}

/**
 * Extract the first balanced {...} object from a JS snippet. The page's
 * script tag contains more JS after the state object, so a naive
 * `lastIndexOf("}")` can grab a brace from a later statement.
 */
function extractBalancedObject(raw: string): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
		} else if (c === "{") {
			depth++;
		} else if (c === "}") {
			depth--;
			if (depth === 0) return raw.slice(0, i + 1);
		}
	}
	return null;
}

/** Published date, or the record creation date when the vendor hides it. */
function detailListedAt(offer: RpOffer): string | null {
	const published = offer.configuration?.hide_publish_date
		? undefined
		: offer.configuration?.publish_date;
	return parseRpDate(published) ?? parseRpDate(offer.create_date);
}

function parseRpDate(value: string | undefined | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function offerToListing(offer: RpOffer, urlOverride?: string): Listing | null {
	const id = offer.id;
	const name = str(offer.name);
	const slug = str(offer.slug);
	if (!id || !name) return null;

	const stats = offer.stats ?? {};
	const priceMin = num(stats.ranges_price_min);
	const areaMin = num(stats.ranges_area_min);
	const priceM2Min = num(stats.ranges_price_m2_min);

	// Vendor slug for a stable offer URL (/oferty/<vendor>/<slug>-<id>/).
	const stages = offer.groups?.stages ?? [];
	const vendorSlug =
		stages.find((s) => s.offer?.vendor?.slug)?.offer?.vendor?.slug ??
		"deweloper";
	const url =
		urlOverride ??
		`https://rynekpierwotny.pl/oferty/${vendorSlug}/${slug}-${id}/`;

	const coords = offer.geo_point?.coordinates ?? [];
	const lat = coords.length >= 2 ? (coords[1] ?? null) : null;
	const lng = coords.length >= 2 ? (coords[0] ?? null) : null;
	const district = offer.region?.district ?? null;
	// Street + number, used for cross-source dedupe against investmap
	// (same investment listed on both) and for geocoding. The city comes from
	// the offer itself; when the feed omits it, the coordinates pick the
	// region (its first city is the closest honest label available).
	const city =
		offer.region?.city ??
		(lat !== null && lng !== null
			? (regionForPoint(lat, lng)?.cities[0]?.name ?? null)
			: null);
	const streetParts = [offer.street_name, offer.street_number].filter(Boolean);
	const address = streetParts.length
		? [streetParts.join(" "), district, city].filter(Boolean).join(", ")
		: null;
	return {
		source: "rynekpierwotny",
		externalId: String(id),
		url,
		title: name,
		price: priceMin,
		pricePerM2: priceM2Min,
		areaM2: areaMin,
		rooms: null,
		floor: null,
		district,
		address,
		description: null,
		heatingType: null,
		propertyType:
			offer.type === 2 ? "house" : offer.type === 1 ? "apartment" : null,
		features: null,
		// GeoJSON Point coordinates are [lng, lat].
		lat,
		lng,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}
