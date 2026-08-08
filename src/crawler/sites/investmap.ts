import type { CheerioAdapter, Listing } from "../types.ts";

/**
 * Investmap.pl — the aggregator that maps (nearly) every Polish
 * development investment, including small private ones that never appear
 * on otodom/olx. Its public JSON API returns investments WITH their
 * individual flats for sale:
 *
 *   GET /api/investment/search?withEstates=1&categorySlug=mieszkania
 *       &citySlug=krakow&offset=N&limit=20
 *
 * Each item carries the investment (title, street, district, location)
 * and `es[].list` — the flats for sale (area, price, price_m2, floor,
 * rooms, per-flat URL). Only investments with active flats appear in the
 * response body's estate lists; paginate until a page has none.
 *
 * This is the auto-discovery answer for private investments: any new
 * development registered in Kraków shows up here with no per-site work.
 */

const API_BASE =
	"https://investmap.pl/api/investment/search?withEstates=1&categorySlug=mieszkania&citySlug=krakow";
const PAGE_SIZE = 20;
const MAX_PAGES = 100;

interface ImEstate {
	id: number;
	name?: string;
	area?: number;
	price?: number;
	price_m2?: number;
	floor?: number;
	rooms?: number;
	url?: string;
}

interface ImInvestment {
	id: number;
	title?: string;
	street?: string;
	url?: string;
	location?: { lat?: number; lon?: number };
	city?: { name?: string };
	district?: { name?: string };
	es?: Array<{ cid?: number; label?: string; list?: ImEstate[] }>;
}

interface ImResponse {
	count?: number;
	list?: ImInvestment[];
}

export const investmapAdapter: CheerioAdapter = {
	id: "investmap",
	name: "Investmap - Krakow investments with flats",
	kind: "cheerio",
	startUrls: [`${API_BASE}&offset=0&limit=${PAGE_SIZE}`],
	maxRequestsPerCrawl: MAX_PAGES,

	async extractHtml(html, url, enqueue) {
		let data: ImResponse;
		try {
			data = JSON.parse(html) as ImResponse;
		} catch {
			return []; // rate-limited HTML page; crawl will fail loudly enough
		}

		const investments = data.list ?? [];
		const flatsThisPage = investments.reduce(
			(sum, inv) => sum + ((inv.es?.[0]?.list ?? []).length || 0),
			0,
		);

		const listings: Listing[] = [];
		for (const inv of investments) {
			const lat = inv.location?.lat;
			const lng = inv.location?.lon;
			const district = inv.district?.name ?? null;
			const address = inv.street
				? `${inv.street}, ${inv.city?.name ?? "Kraków"}`
				: null;
			for (const estate of inv.es?.[0]?.list ?? []) {
				const area = estate.area && estate.area > 0 ? estate.area : null;
				listings.push({
					source: "investmap",
					externalId: String(estate.id),
					url: estate.url
						? `https://investmap.pl${estate.url}`
						: `https://investmap.pl${inv.url ?? ""}`,
					title: estate.name ?? inv.title ?? "Mieszkanie na sprzedaż",
					price: estate.price ?? null,
					pricePerM2: estate.price_m2 ?? null,
					areaM2: area,
					rooms: estate.rooms && estate.rooms > 0 ? estate.rooms : null,
					floor: typeof estate.floor === "number" ? String(estate.floor) : null,
					district,
					address,
					lat: lat && lng ? lat : null,
					lng: lat && lng ? lng : null,
					listedAt: null,
					scrapedAt: new Date().toISOString(),
				});
			}
		}

		// Continue while the API keeps returning flats; stop on an empty
		// page (investments without active flats are not worth pages).
		const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
		const count = data.count ?? 0;
		if (
			flatsThisPage > 0 &&
			offset + PAGE_SIZE < count &&
			offset + PAGE_SIZE < MAX_PAGES * PAGE_SIZE
		) {
			await enqueue([
				`${API_BASE}&offset=${offset + PAGE_SIZE}&limit=${PAGE_SIZE}`,
			]);
		}

		return listings;
	},
};
