import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { regionsForPoint } from "../regions.ts";
import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";
import { cleanText } from "./html-entities.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { num, str } from "./ldoffer.ts";

/**
 * Mapa Licytacji (mapalicytacji.pl) — a public aggregator of Polish
 * property auctions and tenders *other than* court-execution auctions:
 *
 * - gminne (municipal) tenders
 * - AMW (Agencja Mienia Wojskowego, military property)
 * - KOWR (agricultural land)
 * - skarbowe (KAS tax-office e-auctions; the official portal is
 *   Incapsula-protected, this feed is the accessible mirror)
 * - Orange and TAURON corporate property sales
 *
 * Komornik notices are deliberately not crawled here: the dedicated
 * `licytacje.komornik.pl` adapter already covers them.
 *
 * List pages are plain server-rendered cards with `/przetarg-*` and
 * `/nieruchomosc-*` links, paginated with `?strona=N`. Detail pages carry
 * a schema.org Place / RealEstateListing (AMW, KOWR, skarbowe), a
 * `table.details` with area/price/deadline, and often a `var it = {...}`
 * JS object with exact coordinates and the organizer URL.
 *
 * The dataset is regional but the national categories (AMW, gminne,
 * Orange, TAURON) are filtered by the detail page's coordinates/region.
 * Detail responses are cached for a few days and re-emitted, so a
 * list-only rerun or a reset DB still gets coordinates.
 */

const BASE = "https://mapalicytacji.pl";
const DETAIL_CACHE_PATH = "data/crawler/mapalicytacji-details.json";
const DETAIL_TTL_DAYS = 3;
const MAX_DETAILS_PER_RUN = 1200;

interface CategorySeed {
	url: string;
	/** Fallback type when the detail URL does not carry one. */
	type: string;
}

const SEEDS: CategorySeed[] = [
	{ url: `${BASE}/przetargi-gminne`, type: "gminne" },
	{ url: `${BASE}/przetargi-amw`, type: "amw" },
	{ url: `${BASE}/grunty-kowr/malopolskie`, type: "kowr" },
	{ url: `${BASE}/grunty-kowr/slaskie`, type: "kowr" },
	{ url: `${BASE}/licytacje-skarbowe/malopolskie`, type: "skarbowe" },
	{ url: `${BASE}/licytacje-skarbowe/slaskie`, type: "skarbowe" },
	{ url: `${BASE}/nieruchomosci-orange`, type: "orange" },
	{ url: `${BASE}/nieruchomosci-tauron`, type: "tauron" },
	{ url: `${BASE}/nieruchomosci-pkp`, type: "pkp" },
];

type Selector = (selector: string | unknown) => CheerioSelection;

interface CachedDetail {
	fetchedAt: string;
	listing: Listing;
}

let cacheState: Record<string, CachedDetail> | null = null;

function loadCache(): Record<string, CachedDetail> {
	if (cacheState) return cacheState;
	let parsed: Record<string, CachedDetail> = {};
	try {
		parsed = JSON.parse(readFileSync(DETAIL_CACHE_PATH, "utf8"));
	} catch {
		// Missing or corrupt cache: start empty, details simply re-fetch.
	}
	cacheState = parsed;
	return parsed;
}

function saveCache(cache: Record<string, CachedDetail>): void {
	mkdirSync(dirname(DETAIL_CACHE_PATH), { recursive: true });
	writeFileSync(DETAIL_CACHE_PATH, JSON.stringify(cache));
}

function cacheFresh(entry: CachedDetail | undefined): boolean {
	if (!entry?.fetchedAt) return false;
	const fetched = Date.parse(entry.fetchedAt);
	return Number.isFinite(fetched)
		? Date.now() - fetched < DETAIL_TTL_DAYS * 86_400_000
		: false;
}

function absoluteUrl(href: string | null | undefined): string | null {
	if (!href) return null;
	try {
		return new URL(href, BASE).href;
	} catch {
		return null;
	}
}

function externalIdOf(url: string, type: string): string {
	const parts = new URL(url).pathname.split("/").filter(Boolean);
	// `/nieruchomosc-pkp/28583/slug` and `/licytacja-skarbowa/<uuid>/slug`
	// use the second segment as the stable id; AMW's `/przetarg-amw/slug`
	// has only one segment after the prefix.
	const id = parts[1] ?? parts[0] ?? url;
	return `${type}:${id}`;
}

function parseNumberText(value: string | null | undefined): number | null {
	if (!value) return null;
	const n = Number.parseFloat(
		value.replace(/[\s\u00a0]/g, "").replace(",", "."),
	);
	return Number.isFinite(n) ? n : null;
}

function priceFromText(text: string): number | null {
	return parseNumberText(text.match(/([\d\s\u00a0.,]+)\s*zł/iu)?.[1]);
}

/** "0,4711 ha (4 711 m²)" -> 4711; "104,94 m²" -> 104.94. */
function areaM2FromText(text: string): number | null {
	const square = text.match(/([\d\s\u00a0.,]+)\s*m[²2]/iu);
	if (square) return parseNumberText(square[1]);
	const ares = text.match(/([\d\s\u00a0.,]+)\s*ar(?:ów|y|a)?\b/iu);
	if (ares) {
		const ar = parseNumberText(ares[1]);
		return ar === null ? null : ar * 100;
	}
	const hectares = text.match(/([\d\s\u00a0.,]+)\s*ha\b/iu);
	if (hectares) {
		const ha = parseNumberText(hectares[1]);
		return ha === null ? null : ha * 10_000;
	}
	return null;
}

function dateFromText(text: string | null | undefined): string | null {
	if (!text) return null;
	const match = text.match(
		/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/u,
	);
	if (!match) return null;
	const pad = (value: string) => value.padStart(2, "0");
	return `${match[3]}-${pad(match[2])}-${pad(match[1])}T${pad(match[4] ?? "0")}:${pad(match[5] ?? "0")}:00`;
}

function typeFromText(text: string): Listing["propertyType"] {
	if (/mieszkan|apartament|lokal mieszkaln|kawaler/iu.test(text)) {
		return "apartment";
	}
	if (/\bdom|budynek mieszkaln|siedlisk|gospodarstw/iu.test(text)) {
		return "house";
	}
	if (/dzia[łl]k|grunt|roln|las|ziem/iu.test(text)) return "plot";
	return null;
}

function auctionTypeFromUrl(url: string, fallback: string): string {
	if (url.includes("/przetarg-gminny/")) return "gminne";
	if (url.includes("/przetarg-amw/")) return "amw";
	if (url.includes("/przetarg-kowr/")) return "kowr";
	if (url.includes("/licytacja-skarbowa/")) return "skarbowe";
	if (url.includes("/nieruchomosc-orange/")) return "orange";
	if (url.includes("/nieruchomosc-tauron/")) return "tauron";
	if (url.includes("/nieruchomosc-pkp/")) return "pkp";
	return fallback;
}

/**
 * Detail paths are singular (`/przetarg-amw/...`, `/przetarg-gminny/...`,
 * `/licytacja-skarbowa/...`, `/nieruchomosc-orange/...`); category pages
 * are plural (`/przetargi-amw`, `/licytacje-skarbowe`, ...). Do not use a
 * plain `startsWith(seed)` test: that also matches `?strona=2`.
 */
function isDetailPath(path: string): boolean {
	return /^\/(?:przetarg-|licytacja-|nieruchomosc-)/u.test(path);
}

function typeLabel(type: string): string {
	switch (type) {
		case "gminne":
			return "Przetarg gminny";
		case "amw":
			return "AMW";
		case "kowr":
			return "KOWR";
		case "skarbowe":
			return "Licytacja skarbowa";
		case "orange":
			return "Orange";
		case "tauron":
			return "TAURON";
		case "pkp":
			return "PKP";
		default:
			return "Przetarg";
	}
}

function tableRows($: Selector): Record<string, string> {
	const rows: Record<string, string> = {};
	const collect = (selector: string) => {
		$(selector).each((_, el) => {
			const row = $(el) as CheerioSelection;
			const th = cleanText(row.find("th").eq(0).text());
			if (th) {
				const value = cleanText(row.find("td").eq(0).text());
				if (value) rows[th.toLowerCase()] = value;
				return;
			}
			const label = cleanText(row.find("td").eq(0).text());
			const value = cleanText(row.find("td").eq(1).text());
			if (label && value) rows[label.toLowerCase()] = value;
		});
	};
	// AMW/KOWR use `table.details`; gminne/skarbowe/Orange/TAURON use a
	// plain table inside `.info`.
	collect("table.details tr");
	collect(".info table tr");
	return rows;
}

function parseItState(html: string): Record<string, unknown> | null {
	const match = html.match(/var\s+it\s*=\s*(\{[\s\S]*?\});/u);
	if (!match) return null;
	try {
		return JSON.parse(match[1]) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function hasLdType(node: Record<string, unknown>, type: string): boolean {
	const value = node["@type"];
	return Array.isArray(value) ? value.includes(type) : value === type;
}

function addressOf(place: Record<string, unknown> | null): {
	address: string | null;
	region: string | null;
} {
	const addressNode = (place?.address ?? {}) as Record<string, unknown>;
	const street = str(addressNode.streetAddress);
	const zip = str(addressNode.postalCode);
	const city = str(addressNode.addressLocality);
	const region = str(addressNode.addressRegion);
	return {
		address:
			[street, zip, city].filter(Boolean).join(", ") ||
			[zip, city].filter(Boolean).join(", ") ||
			null,
		region,
	};
}

function detailToListing(
	html: string,
	url: string,
	$: Selector,
	seedType: string,
): Listing | null {
	const nodes = parseLdJson(html);
	const realEstate =
		findLdNodes(nodes, (node) => hasLdType(node, "RealEstateListing"))[0] ??
		null;
	const saleEvent =
		findLdNodes(nodes, (node) => hasLdType(node, "SaleEvent"))[0] ?? null;
	const place =
		findLdNodes(
			nodes,
			(node) => hasLdType(node, "Place") && node.geo !== undefined,
		)[0] ?? null;
	const it = parseItState(html);
	const table = tableRows($);

	const type = auctionTypeFromUrl(url, str(it?.src) ?? seedType);
	const typeName = typeLabel(type);

	const offerNode = (realEstate?.offers ??
		place?.makesOffer ??
		saleEvent?.offers ??
		{}) as Record<string, unknown>;
	const price =
		num(it?.ov) ??
		num(offerNode.price) ??
		priceFromText(table["cena wywoławcza"] ?? "") ??
		priceFromText(table["cena ofertowa"] ?? "");
	const title =
		cleanText(str(it?.title)) ??
		cleanText(str(place?.name)) ??
		cleanText(str(realEstate?.name)) ??
		cleanText(str(saleEvent?.name)) ??
		"Oferta na Mapie Licytacji";
	const description =
		cleanText(str(realEstate?.description)) ??
		cleanText(str(saleEvent?.description)) ??
		cleanText(str(place?.description)) ??
		cleanText($("p.lead").eq(0).text());
	const addressParts = addressOf(place);
	const address =
		cleanText(str(it?.street)) || cleanText(str(it?.city))
			? [
					cleanText(str(it?.street)),
					cleanText(str(it?.zip)),
					cleanText(str(it?.city)),
				]
					.filter(Boolean)
					.join(", ")
			: (addressParts.address ??
				cleanText(table["adres"] ?? "") ??
				cleanText(table["położenie"] ?? ""));
	let region =
		addressParts.region ??
		cleanText(table["województwo"] ?? "") ??
		cleanText(table["położenie"] ?? "")?.match(
			/woj\.\s*([a-ząćęłńóśźż-]+)/iu,
		)?.[1] ??
		null;
	const lat =
		num(it?.lat) ?? num((place?.geo as Record<string, unknown>)?.latitude);
	const lng =
		num(it?.lon) ?? num((place?.geo as Record<string, unknown>)?.longitude);

	// Region scope: the tracked voivodeships only. The bbox is the final
	// authority when the page states no region.
	const regionText = region?.toLowerCase() ?? "";
	// Exact names: a substring test would treat "dolnośląskie" as "śląskie".
	const regionKey = regionText.replace(/^woj\.?\s*/u, "").trim();
	const inTrackedRegion =
		regionKey === "małopolskie" ||
		regionKey === "malopolskie" ||
		regionKey === "śląskie" ||
		regionKey === "slaskie";
	if (regionText && !inTrackedRegion) return null;
	if (!regionText) {
		if (lat === null || lng === null) return null;
		const regions = regionsForPoint(lat, lng);
		if (regions.length === 0) return null;
		region = regions[0]?.province ?? null;
	}

	const category =
		cleanText(str(it?.cat)) ??
		cleanText(table["kategoria"] ?? "") ??
		cleanText(table["rodzaj"] ?? "") ??
		cleanText(table["typ nieruchomości"] ?? "");
	const propertyType = typeFromText(
		`${title} ${category ?? ""} ${description ?? ""}`,
	);
	// A plot's size is the land, not the building standing on it.
	const areaSource =
		propertyType === "plot"
			? (table["powierzchnia działki"] ??
				table["powierzchnia gruntu"] ??
				table["powierzchnia"] ??
				"")
			: (table["powierzchnia"] ??
				table["powierzchnia budynków"] ??
				table["powierzchnia działki"] ??
				table["powierzchnia gruntu"] ??
				"");
	const areaM2 =
		areaM2FromText(areaSource) ??
		areaM2FromText(description ?? "") ??
		areaM2FromText(title);
	const rooms = parseNumberText(table["liczba pokoi"] ?? table["pokoje"] ?? "");
	const floor = cleanText(table["piętro"] ?? table["kondygnacja"] ?? "");
	const seller =
		cleanText(str(it?.authority)) ??
		cleanText(str((offerNode.seller as Record<string, unknown>)?.name)) ??
		cleanText(table["sprzedający"] ?? "") ??
		cleanText(table["organ egzekucyjny"] ?? "") ??
		cleanText(table["oddział"] ?? "") ??
		cleanText(table["oddział terenowy"] ?? "") ??
		typeName;
	const auctionDate =
		dateFromText(
			table["termin przetargu"] ??
				table["termin składania ofert"] ??
				table["zakończenie licytacji"] ??
				table["rozpoczęcie licytacji"] ??
				"",
		) ??
		str(it?.start) ??
		str(saleEvent?.startDate) ??
		null;
	const listedAt =
		cleanText(str(realEstate?.datePosted)) ??
		(auctionDate ? auctionDate.slice(0, 10) : null);
	// Expired tenders are noise on an opportunity map (the source keeps
	// them in the list until it refreshes).
	if (auctionDate) {
		const deadline = Date.parse(auctionDate);
		if (Number.isFinite(deadline) && deadline < Date.now() - 86_400_000) {
			return null;
		}
	}
	// KOWR mixes sale and lease; a lease has a rent instead of a price.
	if (type === "kowr" && price === null) return null;
	const wadium = priceFromText(table["wadium"] ?? "");
	const parcel = cleanText(table["działka ewidencyjna"] ?? "");
	const organizerUrl =
		cleanText(str(it?.url)) ??
		cleanText($("a.btn[target='_blank']").eq(0).attr("href"));
	const cityName = cleanText(str(it?.city)) ?? null;
	const streetName = cleanText(str(it?.street)) ?? null;

	const features: Record<string, unknown> = {
		auction_type: type,
		auction_label: typeName,
		seller,
		auction_date: auctionDate,
		listed_at: listedAt,
		wadium,
		parcel,
		category,
		region,
		...(cityName ? { city: cityName } : {}),
		...(streetName ? { street: streetName } : {}),
		...(propertyType === "plot" && areaM2 != null ? { plot_area: areaM2 } : {}),
		portal_status: "active",
		organizer_url: organizerUrl,
		// A tender is not a court execution; the UI can label it honestly.
		distress_sale: type === "skarbowe",
	};

	const listing: Listing = {
		source: "mapalicytacji",
		externalId: externalIdOf(url, type),
		url,
		title: `${typeName}: ${title}`.slice(0, 240),
		price,
		pricePerM2: price && areaM2 ? price / areaM2 : null,
		areaM2,
		rooms,
		floor,
		district: cleanText(str(it?.city)) ?? null,
		address,
		description: description ? description.slice(0, 2000) : null,
		heatingType: null,
		propertyType,
		features: JSON.stringify(features),
		lat,
		lng,
		listedAt,
		scrapedAt: new Date().toISOString(),
	};

	const cache = loadCache();
	cache[listing.externalId] = {
		fetchedAt: new Date().toISOString(),
		listing,
	};
	saveCache(cache);

	return listing;
}

export const mapalicytacjiAdapter: CheerioAdapter = {
	id: "mapalicytacji",
	name: "Mapa Licytacji - gminne, AMW, KOWR, skarbowe, Orange, TAURON",
	kind: "cheerio",
	startUrls: SEEDS.map((seed) => seed.url),
	maxRequestsPerCrawl: 1400,
	// Auction inventories are small and change daily; walk every page and
	// use the detail cache to avoid refetching unchanged notices hourly.
	alwaysFullCrawl: true,

	async extractHtml(html, url, enqueue, root) {
		const $ = root as unknown as Selector;
		const path = new URL(url).pathname;

		if (isDetailPath(path)) {
			const type = auctionTypeFromUrl(url, "gminne");
			const listing = detailToListing(html, url, $, type);
			return listing ? [listing] : [];
		}

		const seed = SEEDS.find((entry) => url.startsWith(entry.url));
		if (!seed) return [];

		const listings: Listing[] = [];
		const cache = loadCache();
		const detailUrls: string[] = [];
		const seen = new Set<string>();
		$("article.card a[href]").each((_, el) => {
			const anchor = $(el) as CheerioSelection;
			const href = anchor.attr("href");
			if (!href) return;
			if (!/^\/(?:przetarg|licytacja|nieruchomosc)-/u.test(href)) return;
			const detailUrl = absoluteUrl(href);
			if (!detailUrl) return;
			if (seen.has(detailUrl)) return;
			seen.add(detailUrl);
			const type = auctionTypeFromUrl(detailUrl, seed.type);
			const id = externalIdOf(detailUrl, type);
			const cached = cache[id];
			if (cached?.listing && cacheFresh(cached)) {
				listings.push(cached.listing);
				return;
			}
			if (detailUrls.length < MAX_DETAILS_PER_RUN) {
				detailUrls.push(detailUrl);
			}
		});
		if (detailUrls.length > 0) await enqueue(detailUrls);

		const next = $('a[rel="next"]').eq(0).attr("href");
		const nextUrl = absoluteUrl(next);
		if (nextUrl) await enqueue([nextUrl]);

		return listings;
	},
};
