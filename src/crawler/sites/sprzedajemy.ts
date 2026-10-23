import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REGIONS } from "../regions.ts";
import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";
import {
	formatAddressForGeocode,
	minedStreetLooksReal,
	parseAddressFromText,
} from "./address.ts";
import { cleanText } from "./html-entities.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { str } from "./ldoffer.ts";
import { propertyTypeFromListingUrl } from "./property-type.ts";

/**
 * Sprzedajemy.pl — one of the two big Polish general-classifieds sites
 * (Gumtree's successor for private sale listings). It publishes flats,
 * houses and plots in dedicated `.../sprzedaz` category pages per
 * voivodeship, 30 cards per page, paginated with `?offset=30`.
 *
 * The list cards carry price, area, city/district and an absolute posting
 * timestamp (`<time datetime="...">`). The detail page adds the full
 * attribute set (rooms, floor, build year, material, ownership, market),
 * a description and `data-coordinates` on the location element. A small
 * persistent detail pass (8 uncached details per list page) fills those in;
 * list rows are already valid offers, so an unenriched row is still saved.
 *
 * `Sprzedajemy` has no schema.org coordinates in the list, but the detail
 * map center is precise enough to anchor most rows; addresses mined from
 * the title/description remain the geocoding fallback.
 */

const BASE = "https://sprzedajemy.pl";
const DETAIL_BUDGET_PER_PAGE = 8;
const DETAIL_CACHE_PATH = "data/crawler/sprzedajemy-details.json";
const CATEGORIES = ["mieszkania", "domy", "grunty-i-dzialki"] as const;

type Selector = (selector: string | unknown) => CheerioSelection;

interface CachedDetail {
	fetchedAt: string;
	lat: number | null;
	lng: number | null;
	address: string | null;
	description: string | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
	propertyType: string | null;
}

let detailCacheState: Record<string, CachedDetail> | null = null;

function loadDetailCache(): Record<string, CachedDetail> {
	if (detailCacheState) return detailCacheState;
	let parsed: Record<string, Partial<CachedDetail>> = {};
	try {
		parsed = JSON.parse(readFileSync(DETAIL_CACHE_PATH, "utf8"));
	} catch {
		// Missing or corrupt cache: start empty, details simply re-fetch.
	}
	const cache: Record<string, CachedDetail> = {};
	for (const [id, entry] of Object.entries(parsed)) {
		cache[id] = {
			fetchedAt: entry.fetchedAt ?? "",
			lat: typeof entry.lat === "number" ? entry.lat : null,
			lng: typeof entry.lng === "number" ? entry.lng : null,
			address: entry.address ?? null,
			description: entry.description ?? null,
			areaM2: typeof entry.areaM2 === "number" ? entry.areaM2 : null,
			rooms: typeof entry.rooms === "number" ? entry.rooms : null,
			floor: entry.floor ?? null,
			propertyType: entry.propertyType ?? null,
		};
	}
	detailCacheState = cache;
	return cache;
}

function saveDetailCache(cache: Record<string, CachedDetail>): void {
	mkdirSync(dirname(DETAIL_CACHE_PATH), { recursive: true });
	writeFileSync(DETAIL_CACHE_PATH, JSON.stringify(cache));
}

function absoluteUrl(href: string | null | undefined): string | null {
	if (!href) return null;
	try {
		return new URL(href, BASE).href;
	} catch {
		return null;
	}
}

function externalIdOf(url: string): string | null {
	return url.match(/-nr(\d+)(?:[?#/]|$)/u)?.[1] ?? null;
}

function parseNumberText(value: string | null | undefined): number | null {
	if (!value) return null;
	const n = Number.parseFloat(
		value.replace(/[\s\u00a0]/g, "").replace(",", "."),
	);
	return Number.isFinite(n) ? n : null;
}

function priceFromText(text: string): number | null {
	return parseNumberText(text.match(/([\d\s\u00a0]+)\s*zł/iu)?.[1]);
}

function areaFromText(text: string): number | null {
	return parseNumberText(text.match(/([\d\s.,]+)\s*m[²2]/iu)?.[1]);
}

function roomsFromText(text: string): number | null {
	const numeric = text.match(/(\d+)\s*[- ]?pok(?:oi|oje|oj|\.)?\b/iu);
	if (numeric) return Number.parseInt(numeric[1], 10);
	if (/kawaler/iu.test(text)) return 1;
	const words: Array<[RegExp, number]> = [
		[/jednopokoj/iu, 1],
		[/dwupokoj/iu, 2],
		[/trzypokoj/iu, 3],
		[/czteropokoj/iu, 4],
		[/pięciopokoj/iu, 5],
	];
	for (const [re, rooms] of words) if (re.test(text)) return rooms;
	return null;
}

function typeFromCategory(text: string): Listing["propertyType"] {
	if (/mieszkan|apartament|kawaler/iu.test(text)) return "apartment";
	if (/\bdom/iu.test(text)) return "house";
	if (/dzia[łl]k|grunt/iu.test(text)) return "plot";
	return null;
}

/** Sprzedajemy's own "21 Paź 09:10" (year omitted for the current year). */
const MONTHS: Record<string, number> = {
	sty: 1,
	lut: 2,
	mar: 3,
	kwi: 4,
	maj: 5,
	cze: 6,
	lip: 7,
	sie: 8,
	wrz: 9,
	paź: 10,
	paz: 10,
	lis: 11,
	gru: 12,
};

function parseListedAt(value: string | null | undefined): string | null {
	if (!value) return null;
	const text = value.replace(/\s+/g, " ").trim();
	// `<time datetime="2026-10-23 16:35:08">` is already absolute.
	if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/u.test(text)) {
		return text.replace(" ", "T");
	}
	const match = text.match(
		/(\d{1,2})\s+([a-ząćęłńóśźż]{3,12})\s+(\d{1,2}):(\d{2})/iu,
	);
	if (!match) return null;
	const month = MONTHS[match[2].toLowerCase()];
	if (!month) return null;
	const now = new Date();
	const day = String(match[1]).padStart(2, "0");
	const hour = String(match[3]).padStart(2, "0");
	return `${now.getFullYear()}-${String(month).padStart(2, "0")}-${day}T${hour}:${match[4]}:00`;
}

function cardToListing(
	card: CheerioSelection,
	pageUrl: string,
): Listing | null {
	const link =
		card.find("h2.title a").eq(0).attr("href") ??
		card.find("a.offerLink").eq(0).attr("href");
	const url = absoluteUrl(link);
	if (!url) return null;
	const externalId = externalIdOf(url);
	if (!externalId) return null;

	const title =
		cleanText(card.find("h2.title a").eq(0).text()) ??
		cleanText(card.find("a.offerLink").eq(0).text()) ??
		"Oferta Sprzedajemy";
	const price = priceFromText(card.find(".price").eq(0).text());
	const areaText = card.find(".attributes").eq(0).text();
	const areaM2 = areaFromText(areaText);
	const rooms = roomsFromText(title);
	const city = cleanText(card.find(".location .city").eq(0).text());
	const district = cleanText(card.find(".location .precinct").eq(0).text());
	const date = card.find("time.time").eq(0).attr("datetime") ?? null;

	const parsed = parseAddressFromText(title);
	const plausible =
		parsed && minedStreetLooksReal(parsed.street) ? parsed : null;
	const address = plausible
		? formatAddressForGeocode(
				plausible.street,
				plausible.number,
				district,
				city ?? null,
			)
		: [district, city].filter(Boolean).join(", ") || city;

	return {
		source: "sprzedajemy",
		externalId,
		url,
		title: title.slice(0, 240),
		price,
		pricePerM2: price && areaM2 ? price / areaM2 : null,
		areaM2,
		rooms,
		floor: null,
		district,
		address,
		description: null,
		heatingType: null,
		propertyType: propertyTypeFromListingUrl(pageUrl),
		features: JSON.stringify({ list_page: pageUrl }),
		lat: null,
		lng: null,
		listedAt: parseListedAt(date),
		scrapedAt: new Date().toISOString(),
	};
}

function attributesOf($: Selector): Record<string, string> {
	const attributes: Record<string, string> = {};
	$(".attribute-list li.item").each((_, el) => {
		const item = $(el) as CheerioSelection;
		const label = cleanText(item.find("span").eq(0).text())?.toLowerCase();
		const value = cleanText(item.find("strong").eq(0).text());
		if (label && value) attributes[label] = value;
	});
	return attributes;
}

function detailToListing(
	html: string,
	url: string,
	$: Selector,
): Listing | null {
	const externalId =
		$("#detailedInformations").eq(0).attr("data-offer-id") ?? externalIdOf(url);
	if (!externalId) return null;

	const attributes = attributesOf($);
	const attribute = (key: string) => attributes[key] ?? "";
	const nodes = parseLdJson(html);
	const product = findLdNodes(
		nodes,
		(node) =>
			Array.isArray(node["@type"]) &&
			(node["@type"] as unknown[]).includes("Product"),
	)[0];
	const description = cleanText(str(product?.description));

	const title =
		cleanText($("h1.offerTitle").eq(0).text()) ??
		cleanText(str(product?.name)) ??
		"Oferta Sprzedajemy";
	const rawPrice =
		html.match(/"offerPrice"\s*:\s*"([\d.]+)"/u)?.[1] ?? attribute("cena");
	const price = parseNumberText(rawPrice) ?? priceFromText(title);
	const areaM2 = areaFromText(attribute("powierzchnia"));
	const rooms =
		parseNumberText(attribute("liczba pokoi")) ?? roomsFromText(title);
	const floor = cleanText(attribute("piętro") || attribute("pietro"));
	const buildYear = parseNumberText(attribute("rok budowy"));
	const material = cleanText(attribute("materiał budynku"));
	const ownership = cleanText(attribute("forma własności"));
	const market = cleanText(attribute("rynek"));
	const heating = cleanText(attribute("ogrzewanie"));

	const city =
		cleanText($(".location .locationName").eq(0).text())?.replace(
			/,\s*$/u,
			"",
		) ?? null;
	const district =
		cleanText($(".location .locationName").eq(0).attr("data-details")) ?? null;
	const coordsText = $(".location").eq(0).attr("data-coordinates") ?? "";
	const lat = parseNumberText(
		coordsText.match(/['"]?lat['"]?\s*:\s*([\d.-]+)/u)?.[1],
	);
	const lng = parseNumberText(
		coordsText.match(/['"]?lng['"]?\s*:\s*([\d.-]+)/u)?.[1],
	);

	const parsed =
		parseAddressFromText(title) ??
		(description ? parseAddressFromText(description) : null);
	const plausible =
		parsed && minedStreetLooksReal(parsed.street) ? parsed : null;
	const address = plausible
		? formatAddressForGeocode(
				plausible.street,
				plausible.number,
				district,
				city ?? null,
			)
		: [district, city].filter(Boolean).join(", ") || city;

	const categoryText =
		html.match(/"content_category"\s*:\s*"([^"]+)"/u)?.[1] ?? "";
	const propertyType =
		typeFromCategory(categoryText) ?? propertyTypeFromListingUrl(url);

	const listing: Listing = {
		source: "sprzedajemy",
		externalId,
		url,
		title: title.slice(0, 240),
		price,
		pricePerM2:
			price && areaM2
				? price / areaM2
				: parseNumberText(attribute("cena za m²")),
		areaM2,
		rooms,
		floor,
		district,
		address,
		description: description ? description.slice(0, 2000) : null,
		heatingType: heating,
		propertyType,
		features: JSON.stringify({
			market,
			build_year: buildYear,
			building_material: material,
			ownership,
			category: categoryText || null,
		}),
		lat,
		lng,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};

	const cache = loadDetailCache();
	cache[listing.externalId] = {
		fetchedAt: new Date().toISOString(),
		lat: listing.lat,
		lng: listing.lng,
		address: listing.address,
		description: listing.description,
		areaM2: listing.areaM2,
		rooms: listing.rooms,
		floor: listing.floor,
		propertyType: listing.propertyType,
	};
	saveDetailCache(cache);

	return listing;
}

export const sprzedajemyAdapter: CheerioAdapter = {
	id: "sprzedajemy",
	name: "Sprzedajemy - Małopolska + Śląsk classifieds (flats, houses, plots)",
	kind: "cheerio",
	startUrls: REGIONS.flatMap((region) =>
		CATEGORIES.map(
			(category) => `${BASE}/${region.name}/nieruchomosci/${category}/sprzedaz`,
		),
	),
	maxRequestsPerCrawl: 700,
	firstPageOnlyRequests:
		REGIONS.length * CATEGORIES.length * (1 + DETAIL_BUDGET_PER_PAGE),

	async extractHtml(html, url, enqueue, root) {
		const $ = root as unknown as Selector;
		if (/-nr\d+/u.test(url)) {
			const listing = detailToListing(html, url, $);
			return listing ? [listing] : [];
		}

		const listings: Listing[] = [];
		$('li[id^="offer-"]').each((_, el) => {
			const card = $(el) as CheerioSelection;
			const listing = cardToListing(card, url);
			if (listing) listings.push(listing);
		});

		const cache = loadDetailCache();
		const detailUrls: string[] = [];
		for (const listing of listings) {
			const cached = cache[listing.externalId];
			if (cached) {
				listing.lat = cached.lat ?? listing.lat;
				listing.lng = cached.lng ?? listing.lng;
				listing.address = cached.address ?? listing.address;
				listing.description = cached.description ?? listing.description;
				listing.areaM2 = cached.areaM2 ?? listing.areaM2;
				listing.rooms = cached.rooms ?? listing.rooms;
				listing.floor = cached.floor ?? listing.floor;
				listing.propertyType = cached.propertyType ?? listing.propertyType;
				continue;
			}
			if (detailUrls.length >= DETAIL_BUDGET_PER_PAGE) break;
			detailUrls.push(listing.url);
		}
		if (detailUrls.length > 0) await enqueue(detailUrls);

		const pageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
		if (!pageOnly) {
			const next = $("li.next a").eq(0).attr("href");
			const nextUrl = absoluteUrl(next);
			if (nextUrl) await enqueue([nextUrl]);
		}

		return listings;
	},
};
