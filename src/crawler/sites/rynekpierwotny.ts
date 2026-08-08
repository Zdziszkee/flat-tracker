import type { CheerioAdapter, Listing } from "../types.ts";
import { num, str } from "./ldoffer.ts";

/**
 * Rynekpierwotny lists new-development projects (osiedla), not individual
 * flats. The page state lives in window.__INITIAL_STATE__ (offerList.list.
 * offers); each offer carries a geo point, price/area ranges for its units
 * and the number of flats for sale. We store the project with its minimum
 * unit price/area as representative values.
 */
export const rynekpierwotnyAdapter: CheerioAdapter = {
	id: "rynekpierwotny",
	name: "Rynekpierwotny - Krakow new developments",
	kind: "cheerio",
	// sort=2 orders the list newest-first, so a bounded crawl always
	// starts with the freshest investments.
	startUrls: ["https://rynekpierwotny.pl/s/nowe-mieszkania-krakow/?sort=2"],
	maxRequestsPerCrawl: 20,

	async extractHtml(html, _url, enqueue) {
		const state = parseInitialState(html);
		const offers = state?.offerList?.list?.offers ?? [];

		const listings: Listing[] = [];
		for (const offer of offers) {
			const listing = offerToListing(offer);
			if (listing) listings.push(listing);
		}

		// Follow the canonical "next" link until the list is exhausted
		// (count/page_size bounds it; the page state is authoritative).
		const list = state?.offerList?.list;
		const page = list?.page ?? 1;
		const pageSize = list?.page_size ?? offers.length;
		const count = list?.count ?? 0;
		const next = state?.metaData?.standardMetaData?.next;
		if (typeof next === "string" && next && page * pageSize < count) {
			await enqueue([next.replaceAll("&amp;", "&")]);
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
}

interface RpOffer {
	id?: number;
	name?: string;
	slug?: string;
	address?: string;
	geo_point?: { coordinates?: number[] };
	region?: { district?: string; city?: string };
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

function offerToListing(offer: RpOffer): Listing | null {
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
	const url = `https://rynekpierwotny.pl/oferty/${vendorSlug}/${slug}-${id}/`;

	const coords = offer.geo_point?.coordinates ?? [];
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
		district: offer.region?.district ?? null,
		address: null,
		// GeoJSON Point coordinates are [lng, lat].
		lat: coords.length >= 2 ? coords[1] : null,
		lng: coords.length >= 2 ? coords[0] : null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}
