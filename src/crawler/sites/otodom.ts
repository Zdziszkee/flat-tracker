import type { CheerioAdapter, Listing } from "../types.ts";

interface NextData {
	props?: {
		pageProps?: {
			data?: {
				searchAds?: {
					items?: OtodomListItem[];
					pagination?: { totalPages?: number; currentPage?: number };
				};
			};
			unifiedAd?: OtodomDetail;
		};
	};
}

interface OtodomListItem {
	id: number;
	title: string;
	slug: string;
	totalPrice?: { value?: number };
	pricePerSquareMeter?: { value?: number };
	areaInSquareMeters?: number;
	roomsNumber?: string;
	floorNumber?: string;
	dateCreated?: string;
	location?: {
		reverseGeocoding?: {
			locations?: Array<{ name?: string; locationLevel?: string }>;
		};
	};
}

interface OtodomDetail {
	id?: string;
	title?: string;
	price?: { salePrice?: { value?: number } };
	attributes?: Record<string, string | number | string[] | undefined>;
	location?: {
		coordinates?: { latitude?: number; longitude?: number };
		reverseGeocoding?: {
			locations?: Array<{ name?: string; locationLevel?: string }>;
		};
	};
	lifecycle?: { createdAt?: string };
}

const ROOMS: Record<string, number> = {
	ONE: 1,
	TWO: 2,
	THREE: 3,
	FOUR: 4,
	FIVE: 5,
	SIX: 6,
	SEVEN: 7,
	EIGHT: 8,
};

/** Parse the JSON payload embedded in every otodom page. */
export function parseOtodomHtml(html: string): NextData {
	const raw = html.match(
		/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
	)?.[1];
	if (!raw) throw new Error("__NEXT_DATA__ not found on page");
	return JSON.parse(raw) as NextData;
}

function districtOf(
	locations: Array<{ name?: string; locationLevel?: string }> | undefined,
): string | null {
	const district = locations?.find((l) => l.locationLevel === "district");
	return district?.name ?? null;
}

function listItemToListing(item: OtodomListItem): Listing {
	return {
		source: "otodom",
		externalId: String(item.id),
		url: `https://www.otodom.pl/pl/oferta/${item.slug}`,
		title: item.title ?? "Otodom listing",
		price: item.totalPrice?.value ?? null,
		pricePerM2: item.pricePerSquareMeter?.value ?? null,
		areaM2: item.areaInSquareMeters ?? null,
		rooms: item.roomsNumber ? (ROOMS[item.roomsNumber] ?? null) : null,
		floor: item.floorNumber ?? null,
		district: districtOf(item.location?.reverseGeocoding?.locations),
		lat: null,
		lng: null,
		listedAt: item.dateCreated
			? new Date(item.dateCreated.replace(" ", "T")).toISOString()
			: null,
		scrapedAt: new Date().toISOString(),
	};
}

function detailToListing(detail: OtodomDetail, url: string): Listing {
	const attrs = detail.attributes ?? {};
	const price = detail.price?.salePrice?.value ?? null;

	return {
		source: "otodom",
		externalId: String(detail.id ?? ""),
		url,
		title: detail.title ?? "Otodom listing",
		price,
		pricePerM2: Number(attrs.price_per_m) || null,
		areaM2: Number(attrs.m) || null,
		rooms: Number(attrs.rooms_num) || null,
		floor: typeof attrs.floor_no === "string" ? attrs.floor_no : null,
		district: districtOf(detail.location?.reverseGeocoding?.locations),
		lat: detail.location?.coordinates?.latitude ?? null,
		lng: detail.location?.coordinates?.longitude ?? null,
		listedAt: detail.lifecycle?.createdAt ?? null,
		scrapedAt: new Date().toISOString(),
	};
}

export function isOtodomDetailUrl(url: string): boolean {
	return url.includes("/oferta/");
}

const KRAKOW_LIST_URL =
	"https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/malopolskie/krakow/krakow/krakow?limit=36&by=LATEST&direction=DESC";

/**
 * Adapter for otodom.pl flat listings in Krakow.
 *
 * Search pages ship `__NEXT_DATA__` JSON inside the HTML (no JS needed), so
 * this is a Cheerio crawler. List pages yield listings without coordinates;
 * the adapter enqueues each detail page, whose `unifiedAd` payload includes
 * precise lat/lng. The DB sink upserts by (source, externalId), so detail
 * records refine list records.
 */
export const otodomAdapter: CheerioAdapter = {
	id: "otodom",
	name: "Otodom - Krakow flats for sale",
	kind: "cheerio",
	startUrls: [KRAKOW_LIST_URL],
	maxRequestsPerCrawl: 6000,

	async extractHtml(html, url, enqueue) {
		const data = parseOtodomHtml(html);
		const pageProps = data.props?.pageProps;

		// Detail pages: full data + coordinates.
		if (isOtodomDetailUrl(url) && pageProps?.unifiedAd) {
			const listing = detailToListing(pageProps.unifiedAd, url);
			return listing.externalId ? [listing] : [];
		}

		// List pages: items without coordinates; enqueue details + next pages.
		const searchAds = pageProps?.data?.searchAds;
		const items = searchAds?.items ?? [];
		const pagination = searchAds?.pagination;

		// dateCreated looks like "2026-08-04 21:39:19" (Europe/Warsaw local).
		const since = this.since ? new Date(this.since) : null;
		const itemDate = (item: OtodomListItem): Date | null =>
			item.dateCreated ? new Date(item.dateCreated.replace(" ", "T")) : null;
		const isRecent = (item: OtodomListItem): boolean => {
			if (!since) return true;
			const d = itemDate(item);
			return d === null || d >= since; // cannot judge, keep it
		};

		const listings = items.map(listItemToListing);

		// Only enqueue detail pages for postings within the since window.
		const recentItems = items.filter(isRecent);
		await enqueue(
			recentItems.map((item) => `https://www.otodom.pl/pl/oferta/${item.slug}`),
		);

		// The list is sorted newest-first (by push date, so a single pushed-up
		// old ad can sit on page 1). Continue pagination while the newest
		// creation date on the page is still inside the window; once an entire
		// page predates `since`, later pages do too.
		const newest = items.reduce<Date | null>(
			(max, item) => {
				const d = itemDate(item);
				return d && (!max || d > max) ? d : max;
			},
			null,
		);
		console.log(
			`otodom list: items=${items.length} recent=${recentItems.length} currentPage=${pagination?.currentPage ?? "?"} newest=${newest?.toISOString().slice(0, 10) ?? "?"}`,
		);
		const pageStillFresh = !since || newest === null || newest >= since;
		if (pagination?.currentPage && pageStillFresh && items.length > 0) {
			const current = pagination.currentPage;
			const nextUrl = `${KRAKOW_LIST_URL}&page=${current + 1}`;
			await enqueue([nextUrl]);
		}

		return listings;
	},
};
