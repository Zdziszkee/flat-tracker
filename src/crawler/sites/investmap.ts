import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * response body's estate lists; paginate across the whole list, because
 * small private investments sit past pages that have no flats.
 *
 * This is the auto-discovery answer for private investments: any new
 * development registered in Kraków shows up here with no per-site work.
 *
 * Construction timeline ("realizacja"): the search rows carry only empty
 * `finish: {}` placeholders - the planned completion quarter lives on the
 * per-investment detail endpoint:
 *
 *   GET /api/investment?id=<id>
 *
 * `investment.finish` = { title: "I kw. 2026", date: "2026-01-01" } is the
 * "realizacja"/odbiór quarter rendered on /miasto/krakow cards: planned
 * while the project is underway, actual for delivered ones (the source
 * does not distinguish), `date` being the first day of that quarter.
 * Investmap publishes NO construction start date and NO status field
 * anywhere (search + detail API, page HTML/APP_STATE, LD+JSON, JS
 * bundles, `details` key union across every Kraków investment = inwestor,
 * realizacja, wykonawca, projektant), so none are stored - never invent
 * values. The timeline rides to the rows as `construction_end_label` /
 * `construction_end_date` in `features` (promoted to columns by db-sink).
 *
 * Detail fetches are gated by data/crawler/investmap-investments.json
 * (keyed on investment id, 30-day TTL): the first run walks every
 * investment with flats, later runs fetch only new ones plus the monthly
 * refresh, so the hourly crawl stays light. Detail pages re-emit the
 * investment's flats (the response's `estates` mirrors the search `es`),
 * refining the search rows through the upsert.
 */

const API_BASE =
	"https://investmap.pl/api/investment/search?withEstates=1&categorySlug=mieszkania&citySlug=krakow";
const DETAIL_BASE = "https://investmap.pl/api/investment";
const PAGE_SIZE = 20;
const MAX_PAGES = 100;
// 85 search pages + one detail request per investment with flats (all of
// them on the first run, a handful per month afterwards thanks to the
// timeline cache).
const MAX_REQUESTS = 600;
/** Timeline detail TTL: quarter-precision data, refreshed monthly. */
const DETAIL_REFRESH_DAYS = 30;

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

interface ImEstateGroup {
	cid?: number;
	label?: string;
	list?: ImEstate[];
}

interface ImInvestment {
	id: number;
	title?: string;
	street?: string;
	url?: string;
	location?: { lat?: number; lon?: number };
	city?: { name?: string };
	district?: { name?: string };
	es?: ImEstateGroup[];
	/** Investment record last edit ("2026-01-27 14:03:47"). */
	updated_at?: string;
	/** "Realizacja" quarter: { title: "I kw. 2026", date: "2026-01-01" }. */
	finish?: { title?: string; date?: string };
}

interface ImResponse {
	count?: number;
	list?: ImInvestment[];
}

interface ImDetailResponse {
	investment?: ImInvestment;
	estates?: ImEstateGroup[];
}

/** What the last successful detail fetch saw (and when). */
export interface CachedInvestment {
	fetchedAt: string;
	updatedAt: string | null;
	constructionEndLabel: string | null;
	constructionEndDate: string | null;
}

let investmentCacheState: Record<string, CachedInvestment> | null = null;

/** Per-investment timeline cache (data/crawler/investmap-investments.json,
 * overridable via INVESTMAP_INVESTMENT_CACHE for the validator): keyed by
 * investment id, it records the published `finish` pair and when the
 * detail endpoint last answered, so re-crawls only refetch what is new or
 * older than DETAIL_REFRESH_DAYS and list-page rows keep the timeline
 * without a refetch. */
function investmentCachePath(): string {
	return (
		process.env.INVESTMAP_INVESTMENT_CACHE ??
		"data/crawler/investmap-investments.json"
	);
}

function loadInvestmentCache(): Record<string, CachedInvestment> {
	if (investmentCacheState) return investmentCacheState;
	let parsed: Record<string, Partial<CachedInvestment>> = {};
	try {
		parsed = JSON.parse(readFileSync(investmentCachePath(), "utf8"));
	} catch {
		// Missing or corrupt cache: start empty, investments simply refetch.
	}
	const cache: Record<string, CachedInvestment> = {};
	for (const [id, entry] of Object.entries(parsed)) {
		cache[id] = {
			fetchedAt: entry.fetchedAt ?? "",
			updatedAt: entry.updatedAt ?? null,
			constructionEndLabel: entry.constructionEndLabel ?? null,
			constructionEndDate: entry.constructionEndDate ?? null,
		};
	}
	investmentCacheState = cache;
	return cache;
}

function saveInvestmentCache(cache: Record<string, CachedInvestment>): void {
	const path = investmentCachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cache));
}

/**
 * The published timeline, verbatim. `finish.title` is kept as-is ("I kw.
 * 2026"); `finish.date` is kept only when it is the ISO quarter-start the
 * API emits ("2026-01-01"). A label without a date (or vice versa) is
 * still stored - what the source gives, nothing invented.
 */
export function timelineOf(inv: ImInvestment): CachedInvestment {
	const rawLabel = inv.finish?.title;
	const rawDate = inv.finish?.date;
	const label =
		typeof rawLabel === "string" && rawLabel.trim() ? rawLabel.trim() : null;
	const date =
		typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(rawDate)
			? rawDate
			: null;
	return {
		fetchedAt: new Date().toISOString(),
		updatedAt: inv.updated_at ?? null,
		constructionEndLabel: label,
		constructionEndDate: date,
	};
}

/** One investment's flats as listings, timeline attached to `features`. */
function investmentToListings(
	inv: ImInvestment,
	groups: ImEstateGroup[] | undefined,
	timeline: CachedInvestment | null,
): Listing[] {
	const lat = inv.location?.lat;
	const lng = inv.location?.lon;
	const district = inv.district?.name ?? null;
	const address = inv.street
		? `${inv.street}, ${inv.city?.name ?? "Kraków"}`
		: null;
	const listings: Listing[] = [];
	for (const estate of groups?.[0]?.list ?? []) {
		const area = estate.area && estate.area > 0 ? estate.area : null;
		const features: Record<string, unknown> = { investment_id: inv.id };
		if (timeline?.constructionEndLabel)
			features.construction_end_label = timeline.constructionEndLabel;
		if (timeline?.constructionEndDate)
			features.construction_end_date = timeline.constructionEndDate;
		listings.push({
			source: "investmap",
			externalId: String(estate.id),
			url: estate.url
				? `https://investmap.pl${estate.url}`
				: `https://investmap.pl${inv.url ?? ""}`,
			// Investment name prefix enables cross-source dedupe with
			// rynekpierwotny (same investment, project-level there).
			title: inv.title
				? `${inv.title} — ${estate.name ?? "Mieszkanie na sprzedaż"}`
				: (estate.name ?? "Mieszkanie na sprzedaż"),
			price: estate.price ?? null,
			pricePerM2: estate.price_m2 ?? null,
			areaM2: area,
			rooms: estate.rooms && estate.rooms > 0 ? estate.rooms : null,
			floor: typeof estate.floor === "number" ? String(estate.floor) : null,
			district,
			address,
			description: null,
			heatingType: null,
			propertyType: null,
			features: JSON.stringify(features),
			lat: lat && lng ? lat : null,
			lng: lat && lng ? lng : null,
			listedAt: null,
			scrapedAt: new Date().toISOString(),
		});
	}
	return listings;
}

export const investmapAdapter: CheerioAdapter = {
	id: "investmap",
	name: "Investmap - Krakow investments with flats",
	kind: "cheerio",
	startUrls: [`${API_BASE}&offset=0&limit=${PAGE_SIZE}`],
	maxRequestsPerCrawl: MAX_REQUESTS,
	// Small private investments sit past pages that have no flats; a
	// newest-first first-page skip would hide them forever. Always walk.
	alwaysFullCrawl: true,

	async extractHtml(html, url, enqueue) {
		// Per-investment detail endpoint: the only place the "realizacja"
		// timeline lives. Re-emits the investment's flats so the upsert
		// refines the search rows with the fresh timeline.
		if (url.includes("/api/investment?id=")) {
			let detail: ImDetailResponse;
			try {
				detail = JSON.parse(html) as ImDetailResponse;
			} catch {
				return [];
			}
			const inv = detail.investment;
			if (!inv?.id) return [];
			const timeline = timelineOf(inv);
			const cache = loadInvestmentCache();
			cache[String(inv.id)] = timeline;
			saveInvestmentCache(cache);
			return investmentToListings(inv, detail.estates, timeline);
		}

		let data: ImResponse;
		try {
			data = JSON.parse(html) as ImResponse;
		} catch {
			return []; // rate-limited HTML page; crawl will fail loudly enough
		}

		const investments = data.list ?? [];
		const listings: Listing[] = [];
		const cache = loadInvestmentCache();
		const toFetch: string[] = [];
		const now = Date.now();
		for (const inv of investments) {
			const cached = cache[String(inv.id)] ?? null;
			const rows = investmentToListings(inv, inv.es, cached);
			if (rows.length === 0) continue;
			listings.push(...rows);
			// Timeline refresh gate: never cached (new investment) or the
			// cached fetch aged past DETAIL_REFRESH_DAYS (quarter-precision
			// data moves slowly; a monthly refetch is plenty).
			const fetchedAt = cached ? Date.parse(cached.fetchedAt) : Number.NaN;
			const stale =
				!Number.isFinite(fetchedAt) ||
				now - fetchedAt > DETAIL_REFRESH_DAYS * 86_400_000;
			if (stale) toFetch.push(`${DETAIL_BASE}?id=${inv.id}`);
		}
		if (toFetch.length > 0) await enqueue(toFetch);

		// The list is sorted with the big estates first, but investments
		// with a handful of flats (the small private ones) still appear
		// past pages that have none — so walk to the very end.
		const offset = Number(new URL(url).searchParams.get("offset") ?? 0);
		const count = data.count ?? 0;
		if (
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
