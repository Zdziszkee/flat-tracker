import type { Page } from "playwright";

import { launchBrowser } from "../browser.ts";
import type { CustomLaunchAdapter, Listing } from "../types.ts";

/**
 * Licytacje komornicze (Krajowa Rada Komornicza) — court auction notices
 * for real estate in Małopolska (flats, houses and plots).
 *
 * The site WAF-rejects non-browser TLS fingerprints (curl/node fetch get
 * "Strona zablokowana"), so a real browser is required. The public API is
 * only reachable same-origin from a rendered page:
 *
 *   POST /services/item-back/rest/item/search  (anonymous, JSON body)
 *
 * The body carries termFilters (province, mainCategory) and a
 * fullTextFilters city match; pagination is `offset` (20/page). Items
 * include the starting price (cena wywołania), auction window, notice
 * creation date and address. Coordinates are usually (0,0) — leave null
 * and let `bun run geocode-addresses` anchor them via the OSM index.
 *
 * Every REAL_ESTATE notice is kept (flats, houses, plots, garages and
 * "inne"/other), so the crawler mirrors the whole Małopolska search feed.
 */

const SEARCH_URL =
	"https://licytacje.komornik.pl/wyszukiwarka-licytacji?province=ma%C5%82opolskie&mainCategory=REAL_ESTATE";
const API_PATH = "/services/item-back/rest/item/search";
const PAGE_SIZE = 20;

interface KomornikAddress {
	street: string | null;
	buildingNo: string | null;
	flatNo: string | null;
	zipCode: string | null;
	city: string | null;
}

interface KomornikItem {
	id: number;
	title: string;
	openingValue: number;
	subCategory: string;
	dateCreated: string;
	startAuctionAt?: string;
	address?: KomornikAddress | null;
	location?: { lat: number; lon: number } | null;
}

interface KomornikPage {
	count?: number;
	items?: KomornikItem[];
}

export const komornikAdapter: CustomLaunchAdapter = {
	id: "licytacje-komornik",
	name: "Licytacje komornicze · Małopolska (nieruchomości)",
	kind: "playwright",
	// WAF-protected: run it on the camoufox browser like Booking rather than
	// Crawlee's own (Playwright chromium) launcher.
	launchBrowser: () => launchBrowser(),
	startUrls: [SEARCH_URL],
	maxRequestsPerCrawl: 3,
	listingSelector: "a.auction",

	async extractListings(page: Page): Promise<Listing[]> {
		const firstPageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
		const items = await page.evaluate(
			async ({ apiPath, pageSize, firstPageOnly }) => {
				const body = {
					limit: pageSize,
					// Newest notices first, so the first page is the incremental
					// window the hourly refresh needs. Matches the search URL's
					// sort=dateCreated DESC.
					orderBy: "DESC",
					orderByField: "dateCreated",
					aggregations: [],
					termFilters: [
						{ field: "province", value: ["małopolskie"] },
						{ field: "mainCategory", value: ["REAL_ESTATE"] },
					],
					offset: 0,
				};
				const all: KomornikItem[] = [];
				for (let offset = 0; ; offset += pageSize) {
					body.offset = offset;
					const res = await fetch(apiPath, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					});
					if (!res.ok) {
						throw new Error(`komornik API HTTP ${res.status}`);
					}
					const data = (await res.json()) as KomornikPage;
					all.push(...(data.items ?? []));
					if (firstPageOnly) break;
					if (!data.count || all.length >= data.count) break;
				}
				return all;
			},
			{ apiPath: API_PATH, pageSize: PAGE_SIZE, firstPageOnly },
		);

		const listings: Listing[] = [];
		for (const item of items) {
			// Scrape every in-scope notice (flats/houses/plots/garages/other).
			// Prefer the notice creation date; fall back to the auction start date.
			const start = item.startAuctionAt
				? Date.parse(item.startAuctionAt)
				: Number.NaN;
			const created = Date.parse(item.dateCreated ?? "");
			const listedAt = Number.isNaN(created)
				? !Number.isNaN(start)
					? new Date(start).toISOString()
					: null
				: new Date(created).toISOString();

			const addr: KomornikAddress = item.address ?? {
				street: null,
				buildingNo: null,
				flatNo: null,
				zipCode: null,
				city: null,
			};
			const house =
				addr.buildingNo && addr.flatNo
					? `${addr.buildingNo}/${addr.flatNo}`
					: (addr.buildingNo ?? addr.flatNo);
			const streetParts = [addr.street?.trim(), house].filter(Boolean);
			const address = [streetParts.join(" "), addr.zipCode, addr.city]
				.filter(Boolean)
				.join(", ");

			// The API ships (0,0) instead of null when unknown; keep null so
			// geocode-addresses can fill the gap via the OSM index.
			const lat = item.location?.lat ?? 0;
			const lng = item.location?.lon ?? 0;

			listings.push({
				source: this.id,
				externalId: String(item.id),
				url: `https://licytacje.komornik.pl/licytacje/${item.id}`,
				title: item.title ?? "",
				price: item.openingValue ?? null,
				pricePerM2: null,
				areaM2: null,
				rooms: null,
				floor: null,
				district: addr.city ?? null,
				address: address || null,
				description: null,
				heatingType: null,
				propertyType: null,
				features: null,
				lat: lat && lng ? lat : null,
				lng: lat && lng ? lng : null,
				listedAt,
				scrapedAt: new Date().toISOString(),
			});
		}
		return listings;
	},
};
