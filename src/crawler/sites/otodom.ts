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
	description?: string;
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
		address: null,
		description: null,
		heatingType: null,
		propertyType: null,
		features: null,
		lat: null,
		lng: null,
		listedAt: item.dateCreated
			? new Date(item.dateCreated.replace(" ", "T")).toISOString()
			: null,
		scrapedAt: new Date().toISOString(),
	};
}

function attrStr(
	attrs: Record<string, string | number | string[] | undefined>,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = attrs[key];
		if (typeof value === "string" && value.trim()) return value;
		if (typeof value === "number") return String(value);
	}
	return null;
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
		address: null,
		description: detail.description ?? null,
		heatingType: attrStr(attrs, ["heating", "heating_type", "ogrzewanie"]),
		propertyType: attrStr(attrs, ["type", "property_type", "building_type"]),
		features: Object.keys(attrs).length ? JSON.stringify(attrs) : null,
		lat: detail.location?.coordinates?.latitude ?? null,
		lng: detail.location?.coordinates?.longitude ?? null,
		// The list page's `dateCreated` is the authoritative "added" date:
		// it is what otodom's `daysSinceCreated` filter uses. The detail's
		// `lifecycle.createdAt` is the original creation date and can be much
		// older for re-pushed ads, so never let it overwrite the list value.
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

export function isOtodomDetailUrl(url: string): boolean {
	return url.includes("/oferta/");
}

const KRAKOW_LIST_BASE =
	"https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/malopolskie/krakow/krakow/krakow?limit=36&by=DEFAULT&direction=DESC";

/** Default fetch window when no `since` is provided (cron runs use 90). */
const DEFAULT_DAYS = 90;

/**
 * otodom's `by=LATEST` sort is ordered by "last bumped/pushed", NOT by
 * creation date, so list pages interleave old promoted ads with new ones and
 * a date-based pagination stop misses fresh offers. Instead we let otodom
 * filter server-side with `daysSinceCreated` and sort by `by=DEFAULT`
 * (creation date, newest first), which makes pagination stable and complete.
 */
function daysSinceCreated(since: string | undefined): number {
	if (!since) return DEFAULT_DAYS;
	const ms = Date.now() - Date.parse(since);
	if (!Number.isFinite(ms) || ms <= 0) return 1;
	// Subtract a minute so a window that is exactly N days (plus the few
	// seconds it takes the crawler to start) resolves to N, not N+1.
	return Math.max(1, Math.ceil((ms - 60_000) / (24 * 60 * 60 * 1000)));
}

function listPageUrl(since: string | undefined, page: number): string {
	return `${KRAKOW_LIST_BASE}&daysSinceCreated=${daysSinceCreated(since)}&page=${page}`;
}

function parseListPage(url: string): { page: number; days: number | null } {
	const u = new URL(url);
	return {
		page: Number(u.searchParams.get("page") ?? 1),
		days: u.searchParams.has("daysSinceCreated")
			? Number(u.searchParams.get("daysSinceCreated"))
			: null,
	};
}

/**
 * Every list page carries a sponsored placeholder ad dated "1999-02-29
 * 00:00:01". Drop it: it is not a real offer and its bogus date would
 * otherwise be saved (then pruned) on every run.
 */
function isRealListing(item: OtodomListItem): boolean {
	if (!item.dateCreated) return true;
	const d = new Date(item.dateCreated.replace(" ", "T"));
	return !Number.isNaN(d.getTime()) && d.getFullYear() >= 2000;
}

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
	startUrls: [listPageUrl(undefined, 1)],
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
		const items = (searchAds?.items ?? []).filter(isRealListing);
		const pagination = searchAds?.pagination;

		// The static start URL carries the default window. Re-seed page 1 with
		// this run's exact window so every page uses the same daysSinceCreated
		// and pagination metadata stays consistent.
		const { page, days } = parseListPage(url);
		const wantDays = daysSinceCreated(this.since);
		if (days !== wantDays) {
			await enqueue([listPageUrl(this.since, page)]);
			return [];
		}

		// dateCreated looks like "2026-08-04 21:39:19" (Europe/Warsaw local).
		const since = this.since ? new Date(this.since) : null;
		const itemDate = (item: OtodomListItem): Date | null =>
			item.dateCreated ? new Date(item.dateCreated.replace(" ", "T")) : null;
		const isRecent = (item: OtodomListItem): boolean => {
			if (!since) return true;
			const d = itemDate(item);
			return d === null || d >= since; // cannot judge, keep it
		};

		// Save and enqueue detail pages only for postings within the window.
		// (The server filter is a whole-day superset of `since`.)
		const recentItems = items.filter(isRecent);
		const listings = recentItems.map(listItemToListing);
		await enqueue(
			recentItems.map((item) => `https://www.otodom.pl/pl/oferta/${item.slug}`),
		);

		const newest = items.reduce<Date | null>((max, item) => {
			const d = itemDate(item);
			return d && (!max || d > max) ? d : max;
		}, null);
		const current = pagination?.currentPage ?? page;
		const totalPages = pagination?.totalPages ?? 0;
		if (current === 1 || current % 10 === 0 || current === totalPages) {
			console.log(
				`otodom list: items=${items.length} recent=${recentItems.length} page=${current}/${totalPages} newest=${newest?.toISOString().slice(0, 10) ?? "?"}`,
			);
		}
		if (current < totalPages && items.length > 0) {
			await enqueue([listPageUrl(this.since, current + 1)]);
		}

		return listings;
	},
};
