import type { CheerioAdapter, Listing } from "../types.ts";
import { parseAddressFromText } from "./address.ts";

interface OlxListState {
	pageNumber?: number;
	totalPages?: number;
	ads?: OlxAd[];
}

interface OlxAd {
	id: number;
	title: string;
	url?: string;
	price?: {
		regularPrice?: { value?: number };
		value?: number;
	};
	params?: Array<{
		key: string;
		normalizedValue?: string;
		value?: string;
	}>;
	location?: {
		cityName?: string;
		districtName?: string;
	};
	map?: {
		lat?: number;
		lon?: number;
	};
	createdTime?: number;
	description?: string;
	category?: { id?: number };
}

/**
 * OLX embeds the full page state as a JSON string in
 * `window.__PRERENDERED_STATE__` inside the HTML source.
 */
export function parseOlxHtml(html: string): Record<string, unknown> {
	const match = html.match(/window\.__PRERENDERED_STATE__=\s*"(\{.*?\})";/s);
	if (!match) throw new Error("__PRERENDERED_STATE__ not found on page");
	return JSON.parse(JSON.parse(`"${match[1]}"`)) as Record<string, unknown>;
}

/** Detail-page state nests the ad; find the object that carries a description. */
function findOlxAd(state: unknown): OlxAd | null {
	const seen = new Set<unknown>();
	const stack = [state];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const v of node) stack.push(v);
			continue;
		}
		const obj = node as Record<string, unknown>;
		if (
			(typeof obj.id === "number" || typeof obj.id === "string") &&
			typeof obj.description === "string"
		) {
			return obj as unknown as OlxAd;
		}
		for (const v of Object.values(obj)) stack.push(v);
	}
	return null;
}

/**
 * The Małopolska landing page mixes sale/rent and unrelated categories
 * (rooms, garages, tents...). Keep only the "sprzedaz" subcategories for
 * flats, houses and plots, using the category map embedded in the page.
 */
function saleCategoryIds(state: Record<string, unknown>): Set<number> | null {
	const cats = (
		state.categories as
			| {
					list?: Record<string, { id?: number; label?: string; path?: string }>;
			  }
			| undefined
	)?.list;
	if (!cats) return null;
	const ids = new Set<number>();
	for (const c of Object.values(cats)) {
		if (
			c?.id != null &&
			c.label === "sprzedaz" &&
			/nieruchomosci\/(mieszkania|domy|dzialki)\//.test(c.path ?? "")
		) {
			ids.add(c.id);
		}
	}
	return ids.size > 0 ? ids : null;
}

function paramValue(ad: OlxAd, key: string): string | undefined {
	return ad.params?.find((p) => p.key === key)?.normalizedValue;
}

const ROOMS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
};

function adToListing(ad: OlxAd, url: string): Listing {
	const pricePerM2 = Number(paramValue(ad, "price_per_m")) || null;
	const areaM2 = Number(paramValue(ad, "m")) || null;
	const roomsRaw = paramValue(ad, "rooms");
	const rooms = roomsRaw ? (ROOMS[roomsRaw.toLowerCase()] ?? null) : null;
	const floor = paramValue(ad, "floor_select");
	const price = ad.price?.regularPrice?.value ?? ad.price?.value ?? null;

	// List pages carry no description; detail pages do. Mine the street from
	// the description first, then the title ("Kraków, ul. Karmelicka 12...").
	const parsed =
		parseAddressFromText(ad.description) ?? parseAddressFromText(ad.title);
	const city = ad.location?.cityName ?? null;
	const address = parsed
		? [
				parsed.number ? `${parsed.street} ${parsed.number}` : parsed.street,
				city,
			]
				.filter(Boolean)
				.join(", ")
		: null;

	return {
		source: "olx",
		externalId: String(ad.id),
		url,
		title: ad.title ?? "OLX listing",
		price,
		pricePerM2,
		areaM2,
		rooms,
		floor: floor ?? null,
		district: ad.location?.districtName ?? city,
		address,
		description: ad.description ?? null,
		heatingType: null,
		propertyType: null,
		features: null,
		lat: ad.map?.lat ?? null,
		lng: ad.map?.lon ?? null,
		listedAt: ad.createdTime ? new Date(ad.createdTime).toISOString() : null,
		scrapedAt: new Date().toISOString(),
	};
}

const MALOPOLSKA_LIST_URL = "https://www.olx.pl/nieruchomosci/malopolskie/";

/**
 * Adapter for olx.pl real-estate listings across Małopolska.
 *
 * OLX renders server-side and embeds the full ad list (including map
 * coordinates) as JSON in the HTML, so no browser is needed. OLX has ~25
 * result pages; the adapter walks them all (the request cap bounds the run)
 * and keeps only postings created within the `since` window.
 */
export const olxAdapter: CheerioAdapter = {
	id: "olx",
	name: "OLX - Małopolska real estate",
	kind: "cheerio",
	startUrls: [MALOPOLSKA_LIST_URL],
	maxRequestsPerCrawl: 1500,

	async extractHtml(html, url, enqueue) {
		const state = parseOlxHtml(html);
		const listing = (state.listing as { listing?: OlxListState } | undefined)
			?.listing;

		// List page: items with coordinates; enqueue detail pages for the
		// recent ones so their descriptions are captured on the next pass.
		if (listing?.ads) {
			const keep = saleCategoryIds(state);
			const ads = (listing.ads ?? []).filter(
				(ad) => !keep || (ad.category?.id != null && keep.has(ad.category.id)),
			);
			const since = this.since ? new Date(this.since) : null;
			const recent = ads.filter((ad) => {
				if (!since) return true;
				if (!ad.createdTime) return true;
				return new Date(ad.createdTime) >= since;
			});

			await enqueue(
				recent.filter((ad) => ad.url).map((ad) => ad.url as string),
			);

			// Pagination: state pageNumber is 0-based, but the ?page=N URL param
			// is 1-based (?page=1 === page 0). Enqueue ?page=pageNumber+2 to get
			// the next page; the since filter above drops older postings.
			const pageNumber = listing.pageNumber ?? 0;
			const totalPages = listing.totalPages ?? 0;
			if (
				pageNumber === 0 ||
				pageNumber % 10 === 0 ||
				pageNumber + 1 === totalPages
			) {
				console.log(
					`olx page: pageNumber=${pageNumber + 1}/${totalPages} ads=${ads.length} recent=${recent.length}`,
				);
			}
			if (pageNumber + 1 < totalPages) {
				await enqueue([`${MALOPOLSKA_LIST_URL}?page=${pageNumber + 2}`]);
			}

			return recent.map((ad) => adToListing(ad, ad.url ?? url));
		}

		// Detail page: refine the list record with the description (and any
		// fields the detail state carries, e.g. heating/type params).
		const ad = findOlxAd(state);
		if (ad) return [adToListing(ad, url)];
		return [];
	},
};
