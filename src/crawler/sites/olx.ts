import type { CheerioAdapter, Listing } from "../types.ts";

interface OlxState {
	listing?: {
		listing?: {
			pageNumber?: number;
			totalPages?: number;
			ads?: OlxAd[];
		};
	};
}

interface OlxAd {
	id: number;
	title: string;
	url: string;
	price?: {
		regularPrice?: { value?: number };
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
}

/**
 * OLX embeds the full page state as a JSON string in
 * `window.__PRERENDERED_STATE__` inside the HTML source.
 */
export function parseOlxHtml(html: string): OlxState {
	const match = html.match(/window\.__PRERENDERED_STATE__=\s*"(\{.*?\})";/s);
	if (!match) throw new Error("__PRERENDERED_STATE__ not found on page");
	return JSON.parse(JSON.parse(`"${match[1]}"`)) as OlxState;
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

function adToListing(ad: OlxAd): Listing {
	const pricePerM2 = Number(paramValue(ad, "price_per_m")) || null;
	const areaM2 = Number(paramValue(ad, "m")) || null;
	const roomsRaw = paramValue(ad, "rooms");
	const rooms = roomsRaw ? (ROOMS[roomsRaw.toLowerCase()] ?? null) : null;
	const floor = paramValue(ad, "floor_select");

	return {
		source: "olx",
		externalId: String(ad.id),
		url: ad.url,
		title: ad.title ?? "OLX listing",
		price: ad.price?.regularPrice?.value ?? null,
		pricePerM2,
		areaM2,
		rooms,
		floor: floor ?? null,
		district: ad.location?.districtName ?? null,
		lat: ad.map?.lat ?? null,
		lng: ad.map?.lon ?? null,
		listedAt: ad.createdTime ? new Date(ad.createdTime).toISOString() : null,
		scrapedAt: new Date().toISOString(),
	};
}

const KRAKOW_LIST_URL =
	"https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/krakow/";

/**
 * Adapter for olx.pl flat listings in Krakow.
 *
 * OLX renders server-side and embeds the full ad list (including map
 * coordinates) as JSON in the HTML, so no browser is needed. OLX has ~25
 * result pages; the adapter walks them all (the request cap bounds the run)
 * and keeps only postings created within the `since` window.
 */
export const olxAdapter: CheerioAdapter = {
	id: "olx",
	name: "OLX - Krakow flats for sale",
	kind: "cheerio",
	startUrls: [KRAKOW_LIST_URL],
	maxRequestsPerCrawl: 1500,

	async extractHtml(html, _url, enqueue) {
		const state = parseOlxHtml(html);
		const listing = state.listing?.listing;
		const ads = listing?.ads ?? [];

		console.log(
			`olx page: pageNumber=${listing?.pageNumber ?? "?"} totalPages=${listing?.totalPages ?? "?"} ads=${ads.length}`,
		);

		const since = this.since ? new Date(this.since) : null;
		const recent = ads.filter((ad) => {
			if (!since) return true;
			if (!ad.createdTime) return true;
			return new Date(ad.createdTime) >= since;
		});

		// Pagination: state pageNumber is 0-based, but the ?page=N URL param
		// is 1-based (?page=1 === page 0). Enqueue ?page=pageNumber+2 to get
		// the next page; the since filter above drops older postings.
		const pageNumber = listing?.pageNumber ?? 0;
		const totalPages = listing?.totalPages ?? 0;
		if (pageNumber + 1 < totalPages) {
			await enqueue([`${KRAKOW_LIST_URL}?page=${pageNumber + 2}`]);
		}

		return recent.map(adToListing);
	},
};
