import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Page } from "playwright";

import { launchPersistentBrowserContext } from "../browser.ts";
import type { CustomLaunchAdapter, Listing } from "../types.ts";

/**
 * eLicytacje KAS (elicytacje.mf.gov.pl) — the official Ministry of Finance
 * portal for tax-office auctions (licytacje skarbowe, przetargi and
 * "obwieszczenia o oszacowaniu"). Since 2026-07-01 it replaced the
 * per-Izba announcements on gov.pl, so it is the primary source for
 * non-komornik state auctions (KAS / Urzędy Skarbowe).
 *
 * The portal sits behind Incapsula, which WAF-blocks plain HTTP clients but
 * lets a real Firefox through after solving its JS challenge. The challenge
 * is remembered in a persistent browser profile under `data/crawler/`, so
 * the hourly refresh reuses the cookie instead of re-solving it (a fresh
 * context every run eventually gets a hard "Request unsuccessful" block).
 *
 * The SPA's own API is same-origin and only reachable from the rendered
 * page, so the adapter runs fetches inside `page.evaluate`:
 *
 *   POST /auction/api/v1/announcement/external?page=N&size=100
 *   GET  /auction/api/v1/announcements/{uuid}
 *   GET  /auction/api/v1/items/{itemId}
 *
 * The search body is `{ sectionId, filters: { location } }`; `location` is
 * the free-text voivodeship/city filter the portal's own search box uses.
 * Only the two tracked voivodeships are queried, which keeps the feed at
 * ~100 announcements rather than the ~600 nationwide.
 *
 * Detail responses carry the address (`item.localizationAddress`), the item
 * category, a description and a parameter list (usable area, rooms, floor,
 * land area). The portal publishes no coordinates, so `lat`/`lng` stay null
 * and `bun run geocode-addresses` anchors the rows through the local OSM
 * index (refreshAll runs that pass automatically).
 *
 * Announcements are cached for three days and refreshed when their
 * electronic state changes, so an hourly run fetches details only for new
 * or changed notices. Ended auctions are pruned after a two-week grace
 * period (see `pruneUnseenListings` in refresh.ts).
 */

const BASE = "https://elicytacje.mf.gov.pl";
const SEARCH_URL = `${BASE}/auction/search`;
const API = "/auction/api/v1";
/** "Nieruchomości" section of the portal. */
const SECTION_NIERUCHOMOSCI = "8777b999-fbac-4696-a11e-5323a52760f1";
const LOCATIONS = ["małopolskie", "śląskie"];
const PROFILE_DIR = "data/crawler/elicytacje-mf-profile";
const DETAIL_CACHE_PATH = "data/crawler/elicytacje-mf-details.json";
const DETAIL_TTL_DAYS = 3;
const DETAIL_CONCURRENCY = 12;
const MAX_DETAILS_PER_RUN = 400;

const VOIVODESHIPS: Record<string, string> = {
	"12": "małopolskie",
	"24": "śląskie",
};

interface ElicytacjeParameter {
	name: string;
	value: string;
}

/** Compact detail record returned from the page and kept in the cache. */
export interface ElicytacjeRecord {
	uuid: string;
	title: string;
	publicationDateTime: string | null;
	saleBeginDateTime: string | null;
	saleEndDateTime: string | null;
	announcementTypeGroupCode: string | null;
	electronicStateCode: string | null;
	announcementNo: string | null;
	authorityName: string | null;
	startingPrice: number | null;
	depositAmount: number | null;
	depositDueDate: string | null;
	auctionSequenceCode: string | null;
	voivodeshipCode: string | null;
	city: string | null;
	streetName: string | null;
	streetNo: string | null;
	apartmentNo: string | null;
	zipCode: string | null;
	additionalInfo: string | null;
	categoryName: string | null;
	description: string | null;
	parameters: ElicytacjeParameter[];
}

interface CachedRecord {
	fetchedAt: string;
	state: string | null;
	record: ElicytacjeRecord;
}

interface ScrapeResult {
	/** Active list rows (uuid + state), used to decide which cache entries survive. */
	active: { uuid: string; state: string | null }[];
	/** Details fetched during this run (cached entries are merged on the Node side). */
	records: ElicytacjeRecord[];
}

type DetailCache = Record<string, CachedRecord>;

let cacheState: DetailCache | null = null;

function loadCache(): DetailCache {
	if (cacheState) return cacheState;
	let parsed: DetailCache = {};
	try {
		parsed = JSON.parse(readFileSync(DETAIL_CACHE_PATH, "utf8")) as DetailCache;
	} catch {
		// Missing or corrupt cache: refetch details.
	}
	cacheState = parsed;
	return parsed;
}

function saveCache(cache: DetailCache): void {
	cacheState = cache;
	mkdirSync(dirname(DETAIL_CACHE_PATH), { recursive: true });
	writeFileSync(DETAIL_CACHE_PATH, JSON.stringify(cache));
}

function parseNumber(value: string | null | undefined): number | null {
	if (!value) return null;
	const n = Number.parseFloat(
		value.replace(/[\s\u00a0]/g, "").replace(",", "."),
	);
	return Number.isFinite(n) ? n : null;
}

/** m² per unit stated in the value or in the parameter name ("(ha)"). */
function areaFactor(text: string): number {
	if (/\bha\b|hektar/iu.test(text)) return 10_000;
	// "ar"/"ara"/"arów" = 100 m². Checked after ha so "hektar" never lands here.
	if (/\bar(?:ów|a|y)?\b/iu.test(text)) return 100;
	return 1;
}

function areaFromText(
	value: string | null | undefined,
	unitHint = "",
): number | null {
	if (!value) return null;
	const n = parseNumber(value);
	if (n === null) return null;
	return n * areaFactor(`${value} ${unitHint}`);
}

function findParameter(
	record: ElicytacjeRecord,
	patterns: RegExp[],
): ElicytacjeParameter | null {
	for (const parameter of record.parameters) {
		if (patterns.some((re) => re.test(parameter.name))) return parameter;
	}
	return null;
}

function parameterValue(
	record: ElicytacjeRecord,
	patterns: RegExp[],
): string | null {
	return findParameter(record, patterns)?.value ?? null;
}

function areaM2Of(
	record: ElicytacjeRecord,
	kind: string | null,
): number | null {
	const usable = findParameter(record, [
		/powierzchnia użytkowa/i,
		/powierzchnia lokalu/i,
	]);
	const land = findParameter(record, [
		/łączna powierzchnia gruntu/i,
		/powierzchnia działki/i,
		/powierzchnia gruntu/i,
	]);
	const building = findParameter(record, [
		/powierzchnia budynk/i,
		/powierzchnia zabudowy/i,
	]);
	if (kind === "plot") {
		const fromLand = areaFromText(land?.value, land?.name);
		if (fromLand !== null) return fromLand;
	}
	const fromUsable = areaFromText(usable?.value, usable?.name);
	if (fromUsable !== null) return fromUsable;
	const fromLand = areaFromText(land?.value, land?.name);
	if (fromLand !== null) return fromLand;
	const fromBuilding = areaFromText(building?.value, building?.name);
	if (fromBuilding !== null) return fromBuilding;
	const text = `${record.title} ${record.description ?? ""}`;
	const match = text.match(/(\d+(?:[.,]\d+)?)\s*(ha|m²|m2|ar(?:ów|a|y)?)\b/iu);
	return match ? areaFromText(`${match[1]} ${match[2]}`) : null;
}

function propertyTypeOf(
	record: ElicytacjeRecord,
): "apartment" | "house" | "plot" | null {
	const category = record.categoryName ?? "";
	if (/mieszkan/i.test(category)) return "apartment";
	if (/^domy\b/i.test(category)) return "house";
	if (/grunt/i.test(category)) {
		// A built plot is a house for the map/table filter; the title is the
		// only place the portal says so.
		return /budynek mieszkalny|\bdom(?:u|y|em|ek|ki|ków)?\b|bli[żz]niak|szeregow|segment/iu.test(
			`${record.title} ${record.description ?? ""}`,
		)
			? "house"
			: "plot";
	}
	// "Lokale użytkowe, hale i magazyny" and anything new stay untyped: they
	// are not flats/houses/plots, so the UI shows them under "Wszystkie".
	return null;
}

function auctionLabel(record: ElicytacjeRecord): string {
	if (record.announcementTypeGroupCode === "OSZNELNIER") {
		return "Obwieszczenie KAS";
	}
	return "Licytacja skarbowa";
}

export function recordToListing(record: ElicytacjeRecord): Listing | null {
	const end = Date.parse(record.saleEndDateTime ?? "");
	if (Number.isFinite(end) && end < Date.now() - 86_400_000) return null;

	const label = auctionLabel(record);
	const propertyType = propertyTypeOf(record);
	const areaM2 = areaM2Of(record, propertyType);
	// A share's starting price buys only that fraction, while the area
	// parameter describes the whole property. A price/m² computed from both
	// would understate the market rate, so leave it null (the title says
	// "Udział 1/2").
	const isShare = /\budział/iu.test(record.title);
	const rooms = parseNumber(
		parameterValue(record, [/liczba pokoi/i, /liczba izb/i]),
	);
	const floor = parameterValue(record, [/^piętro$/i, /kondygnacja/i]);
	const streetNumber = [record.streetNo, record.apartmentNo]
		.filter(Boolean)
		.join("/");
	const streetLine = [record.streetName?.trim(), streetNumber]
		.filter(Boolean)
		.join(" ");
	const cityLine = [record.zipCode, record.city?.trim()]
		.filter(Boolean)
		.join(" ");
	const address = [streetLine, cityLine].filter(Boolean).join(", ") || null;
	const voivodeship = VOIVODESHIPS[record.voivodeshipCode ?? ""] ?? null;

	const features: Record<string, unknown> = {
		auction_type: "skarbowe",
		auction_label: label,
		seller: record.authorityName,
		auction_date: record.saleBeginDateTime,
		auction_end: record.saleEndDateTime,
		auction_round: record.auctionSequenceCode,
		announcement_no: record.announcementNo,
		announcement_type: record.announcementTypeGroupCode,
		electronic_state: record.electronicStateCode,
		wadium: record.depositAmount,
		wadium_due: record.depositDueDate,
		portal_status: "active",
		organizer_url: `${BASE}/auction/announcements/${record.uuid}`,
	};
	if (record.categoryName) features.category = record.categoryName;
	if (record.city) features.city = record.city;
	if (voivodeship) features.voivodeship = voivodeship;
	if (record.zipCode) features.postal_code = record.zipCode;
	if (record.streetName) features.street = record.streetName.trim();
	if (streetNumber) features.street_number = streetNumber;
	if (record.additionalInfo) features.location_note = record.additionalInfo;
	if (isShare) features.share = true;

	const price = record.startingPrice ?? null;
	return {
		source: "elicytacje-mf",
		externalId: record.uuid,
		url: `${BASE}/auction/announcements/${record.uuid}`,
		title: `${label}: ${record.title}`.slice(0, 240),
		price,
		pricePerM2: price && areaM2 && !isShare ? price / areaM2 : null,
		areaM2,
		rooms,
		floor,
		district: record.city?.trim() ?? null,
		address,
		description: record.description ? record.description.slice(0, 2000) : null,
		heatingType: null,
		propertyType,
		features: JSON.stringify(features),
		lat: null,
		lng: null,
		listedAt: record.publicationDateTime,
		scrapedAt: new Date().toISOString(),
	};
}

async function openSearchPage(page: Page): Promise<void> {
	await page.goto(SEARCH_URL, {
		waitUntil: "domcontentloaded",
		timeout: 60_000,
	});
	try {
		await page.waitForSelector("jsp-root", { timeout: 45_000 });
		return;
	} catch {
		// Incapsula's challenge page reloads itself once its script finishes;
		// a reload picks up the solved cookies when the first load raced it.
	}
	await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
	await page.waitForSelector("jsp-root", { timeout: 45_000 });
}

export const elicytacjeMfAdapter: CustomLaunchAdapter = {
	id: "elicytacje-mf",
	name: "eLicytacje KAS - licytacje skarbowe (Małopolska + Śląsk)",
	kind: "playwright",
	startUrls: [SEARCH_URL],
	listingSelector: "jsp-root",
	maxRequestsPerCrawl: 1,
	// The feed is small and the adapter walks its own API pages every run:
	// a first-page-only pass would miss the announcements deeper in the list.
	alwaysFullCrawl: true,

	async launchContext() {
		const context = await launchPersistentBrowserContext(PROFILE_DIR);
		const page = await context.newPage();
		try {
			await openSearchPage(page);
			return context;
		} catch (err) {
			await context.close().catch(() => {});
			throw err;
		} finally {
			await page.close().catch(() => {});
		}
	},

	async extractListings(page: Page): Promise<Listing[]> {
		const cache = loadCache();
		const now = Date.now();
		const known: Record<string, string> = {};
		for (const [uuid, entry] of Object.entries(cache)) {
			if (!entry.record || entry.record.uuid !== uuid) continue;
			const fetched = Date.parse(entry.fetchedAt);
			if (!Number.isFinite(fetched)) continue;
			if (now - fetched > DETAIL_TTL_DAYS * 86_400_000) continue;
			if (entry.state) known[uuid] = entry.state;
		}

		const scraped = (await page.evaluate(
			async (input) => {
				const all: {
					uuid: string;
					title?: string;
					electronicStateCode?: string;
				}[] = [];
				for (const location of input.locations) {
					let pageNo = 0;
					let totalPages = 1;
					while (pageNo < totalPages) {
						const res = await fetch(
							`${input.api}/announcement/external?page=${pageNo}&size=100`,
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									sectionId: input.sectionId,
									filters: { location },
								}),
							},
						);
						if (!res.ok) {
							throw new Error(`elicytacje list HTTP ${res.status}`);
						}
						const data = (await res.json()) as {
							content?: {
								uuid: string;
								title?: string;
								electronicStateCode?: string;
							}[];
							totalPages?: number;
						};
						totalPages = data.totalPages ?? 1;
						for (const row of data.content ?? []) all.push(row);
						pageNo++;
					}
				}

				const unique = new Map<
					string,
					{ uuid: string; state: string | null }
				>();
				for (const row of all) {
					if (!row.uuid) continue;
					const state = row.electronicStateCode ?? null;
					unique.set(row.uuid, { uuid: row.uuid, state });
				}
				const active = [...unique.values()].filter(
					(row) => row.state === "WAITING" || row.state === "INPROGRESS",
				);
				const targets = active.filter(
					(row) => input.known[row.uuid] !== row.state,
				);

				const records: unknown[] = [];
				const capped = targets.slice(0, input.maxDetails);
				for (let i = 0; i < capped.length; i += input.concurrency) {
					const batch = capped.slice(i, i + input.concurrency);
					const results = await Promise.all(
						batch.map(async (row) => {
							let detailRes = await fetch(
								`${input.api}/announcements/${row.uuid}`,
							);
							if (!detailRes.ok) {
								// The portal occasionally drops one request in a
								// concurrent batch; one retry recovers it.
								await new Promise((resolve) => setTimeout(resolve, 700));
								detailRes = await fetch(
									`${input.api}/announcements/${row.uuid}`,
								);
							}
							if (!detailRes.ok) return null;
							const detail = (await detailRes.json()) as {
								announcement?: Record<string, unknown>;
								deposit?: { amount?: number; dueDate?: string } | null;
								auction?: { auctionSequenceCode?: string } | null;
								item?: {
									localizationAddress?: Record<string, unknown>;
								} | null;
							};
							const announcement = (detail.announcement ?? {}) as Record<
								string,
								unknown
							>;
							const itemId =
								typeof announcement.itemId === "string"
									? announcement.itemId
									: null;
							let item: Record<string, unknown> | null = null;
							let parameters: {
								parameterName?: string;
								parameterValue?: string;
							}[] = [];
							if (itemId) {
								let itemRes = await fetch(`${input.api}/items/${itemId}`);
								if (!itemRes.ok) {
									await new Promise((resolve) => setTimeout(resolve, 700));
									itemRes = await fetch(`${input.api}/items/${itemId}`);
								}
								if (itemRes.ok) {
									const itemJson = (await itemRes.json()) as {
										item?: Record<string, unknown>;
										parameters?: {
											parameterName?: string;
											parameterValue?: string;
										}[];
									};
									item = itemJson.item ?? null;
									parameters = itemJson.parameters ?? [];
								}
							}
							const address = (detail.item?.localizationAddress ??
								item?.localizationAddress ??
								{}) as Record<string, unknown>;
							const category = (item?.category ?? {}) as Record<
								string,
								unknown
							>;
							return {
								uuid: row.uuid,
								title: String(announcement.title ?? ""),
								publicationDateTime: announcement.publicationDateTime ?? null,
								saleBeginDateTime: announcement.saleBeginDateTime ?? null,
								saleEndDateTime: announcement.saleEndDateTime ?? null,
								announcementTypeGroupCode:
									announcement.announcementTypeGroupCode ?? null,
								electronicStateCode: row.state,
								announcementNo: announcement.announcementNo ?? null,
								authorityName: announcement.authorityName ?? null,
								startingPrice:
									typeof announcement.startingPrice === "number"
										? announcement.startingPrice
										: null,
								depositAmount: detail.deposit?.amount ?? null,
								depositDueDate: detail.deposit?.dueDate ?? null,
								auctionSequenceCode:
									detail.auction?.auctionSequenceCode ?? null,
								voivodeshipCode: address.voivodeshipCode ?? null,
								city: address.city ?? null,
								streetName: address.streetName ?? null,
								streetNo: address.streetNo ?? null,
								apartmentNo: address.apartmentNo ?? null,
								zipCode: address.zipCode ?? null,
								additionalInfo: address.additionalInfo ?? null,
								categoryName: category.name ?? null,
								description: item?.description ?? null,
								parameters: parameters.map((p) => ({
									name: p.parameterName ?? "",
									value: p.parameterValue ?? "",
								})),
							};
						}),
					);
					for (const result of results) {
						if (result) records.push(result);
					}
				}
				return { active, records };
			},
			{
				api: API,
				sectionId: SECTION_NIERUCHOMOSCI,
				locations: LOCATIONS,
				known,
				concurrency: DETAIL_CONCURRENCY,
				maxDetails: MAX_DETAILS_PER_RUN,
			},
		)) as ScrapeResult;

		const nextCache: DetailCache = {};
		const fetchedByUuid = new Map(
			scraped.records.map((record) => [record.uuid, record] as const),
		);
		const listings: Listing[] = [];
		for (const row of scraped.active) {
			const fetched = fetchedByUuid.get(row.uuid);
			const cached = cache[row.uuid];
			const record = fetched ?? cached?.record;
			if (!record) continue;
			if (fetched) {
				nextCache[row.uuid] = {
					fetchedAt: new Date().toISOString(),
					state: row.state,
					record: fetched,
				};
			} else if (cached) {
				nextCache[row.uuid] = cached;
			}
			const listing = recordToListing(record);
			if (listing) listings.push(listing);
		}
		saveCache(nextCache);
		return listings;
	},
};
