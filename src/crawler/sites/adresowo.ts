import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REGIONS } from "../regions.ts";
import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";
import { formatAddressForGeocode, parseAddressFromText } from "./address.ts";
import { cleanText } from "./html-entities.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { num, str } from "./ldoffer.ts";
import { propertyTypeFromListingUrl } from "./property-type.ts";

/**
 * Adresowo.pl — the largest Polish direct-from-owner portal ("bez
 * pośredników"): flats, houses and plots, split by voivodeship
 * (`/mieszkania/fma` = małopolskie, `/mieszkania/fsl` = śląskie).
 *
 * The list is server-rendered cards (`div[data-offer-card]`, 40 per page,
 * next page via `<link rel="next">`), carrying price/area/rooms, the
 * locality, the street and a short description. Coordinates and the full
 * description live only on the detail page's schema.org `Place` node, so a
 * small persistent detail pass (8 uncached details per list page) fills
 * them over successive runs. The list rows already have an address, so
 * geocoding can place rows whose detail has not been fetched yet.
 *
 * The portal publishes no absolute posting date — only relative copy
 * ("dodana wczoraj") — so `listedAt` stays null and `firstSeenAt` is the
 * map/table date, like the other sources without a posting date.
 */

const BASE = "https://adresowo.pl";
const DETAIL_BUDGET_PER_PAGE = 8;
const DETAIL_CACHE_PATH = "data/crawler/adresowo-details.json";
const CATEGORIES = ["mieszkania", "domy", "dzialki"] as const;
/** Adresowo's voivodeship path codes (`fma`/`fsl`), not the portal slugs. */
const REGION_CODES: Record<string, string> = {
	malopolskie: "fma",
	slaskie: "fsl",
};

type Selector = (selector: string | unknown) => CheerioSelection;

interface CachedDetail {
	fetchedAt: string;
	lat: number | null;
	lng: number | null;
	address: string | null;
	description: string | null;
	title: string | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
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
			title: entry.title ?? null,
			areaM2: typeof entry.areaM2 === "number" ? entry.areaM2 : null,
			rooms: typeof entry.rooms === "number" ? entry.rooms : null,
			floor: entry.floor ?? null,
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

function externalIdOf(url: string): string {
	try {
		return new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
	} catch {
		return url;
	}
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
	const match = text.match(/(\d+)\s*(?:pok(?:oi|oje|oj|\.|ó?j)?\b)/iu);
	if (match) return Number.parseInt(match[1], 10);
	if (/kawalerka/iu.test(text)) return 1;
	return null;
}

function floorFromText(text: string): string | null {
	if (/\bparter\b/iu.test(text)) return "0";
	const match = text.match(/(\d+)\s*pi[eę]tr/iu);
	return match ? match[1] : null;
}

function typeFromText(text: string): Listing["propertyType"] {
	if (/mieszkan|apartament|kawaler/iu.test(text)) return "apartment";
	if (/\bdom/iu.test(text)) return "house";
	if (/dzia[łl]k|grunt/iu.test(text)) return "plot";
	return null;
}

/** "Kraków Podgórze Duchackie" -> city + district; other towns stay whole. */
function splitLocality(locality: string): {
	city: string;
	district: string | null;
} {
	const clean = locality.replace(/\s+/g, " ").trim();
	const parts = clean.split(" ");
	if (parts.length > 1 && /^krak[oó]w$/iu.test(parts[0] ?? "")) {
		return { city: "Kraków", district: parts.slice(1).join(" ") };
	}
	return { city: clean, district: null };
}

function cardToListing(
	card: CheerioSelection,
	pageUrl: string,
): Listing | null {
	const link = card.find('a[href^="/o/"]').eq(0);
	const url = absoluteUrl(link.attr("href"));
	if (!url) return null;

	// The anchor starts with an empty full-card overlay span; the two
	// `line-clamp-1` spans are the locality and the street.
	const spans = link.find("span.line-clamp-1");
	const locality = cleanText(spans.eq(0).text()) ?? "";
	const street = cleanText(spans.eq(1).text()) ?? "";
	const text = card.text().replace(/\s+/g, " ");

	// The first three <p> tags are the price/area/rooms header. Reading the
	// whole card would prepend the photo-count badge ("15 1 990 000 zł").
	const header = card.find("p");
	const price = priceFromText(header.eq(0).text());
	const areaM2 = areaFromText(header.eq(1).text());
	const rooms = roomsFromText(header.eq(2).text());
	const { city, district } = splitLocality(locality);
	const parsedStreet = parseAddressFromText(street);
	const address = parsedStreet
		? formatAddressForGeocode(
				parsedStreet.street,
				parsedStreet.number,
				district,
				city || null,
			)
		: street
			? [street, locality].filter(Boolean).join(", ")
			: locality || null;
	const listDescription =
		cleanText(card.find("p.line-clamp-4").eq(0).text()) ??
		cleanText(card.find("p").eq(4).text());
	const propertyType =
		propertyTypeFromListingUrl(url) ?? typeFromText(link.text());
	const title =
		[locality, street].filter(Boolean).join(", ") || "Oferta Adresowo";

	return {
		source: "adresowo",
		externalId: externalIdOf(url),
		url,
		title,
		price,
		pricePerM2: price && areaM2 ? price / areaM2 : null,
		areaM2,
		rooms,
		floor: floorFromText(text),
		district,
		address,
		// The list card's blurb is short; the detail page owns `description`
		// (a full description must not be overwritten by the next list run).
		description: null,
		heatingType: null,
		propertyType,
		features: JSON.stringify({
			source_category: propertyType,
			private_owner: true,
			list_page: pageUrl,
			list_description: listDescription,
		}),
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

function detailToListing(
	html: string,
	url: string,
	$: Selector,
): Listing | null {
	const nodes = parseLdJson(html);
	const place = findLdNodes(
		nodes,
		(node) => node["@type"] === "Place" && node.geo !== undefined,
	)[0];
	const offerNode = findLdNodes(
		nodes,
		(node) => node["@type"] === "Offer" && node.price !== undefined,
	)[0];
	const geo = (place?.geo ?? {}) as Record<string, unknown>;
	const addressNode = (place?.address ?? {}) as Record<string, unknown>;
	const placeName = str(place?.name);
	const ogTitle = $('meta[property="og:title"]').eq(0).attr("content") ?? null;
	const h1 = cleanText($("h1").eq(0).text());
	const title = h1 ?? cleanText(ogTitle) ?? placeName ?? "Oferta Adresowo";
	const description =
		cleanText(str(place?.description)) ?? cleanText(str(place?.name));

	const rawPrice =
		num(offerNode?.price) ?? priceFromText(`${h1 ?? ""} ${ogTitle ?? ""}`);
	const price = rawPrice && rawPrice > 0 ? rawPrice : null;
	const areaM2 =
		areaFromText(h1 ?? "") ?? areaFromText(placeName ?? "") ?? null;
	const rooms =
		roomsFromText(h1 ?? "") ?? roomsFromText(placeName ?? "") ?? null;
	const floor =
		floorFromText(h1 ?? "") ?? floorFromText(placeName ?? "") ?? null;
	const street = str(addressNode.streetAddress);
	const address = cleanText(street);

	const canonical =
		absoluteUrl($('link[rel="canonical"]').eq(0).attr("href")) ?? url;

	const listing: Listing = {
		source: "adresowo",
		externalId: externalIdOf(url),
		url: canonical,
		title: title.slice(0, 240),
		price,
		pricePerM2: price && areaM2 ? price / areaM2 : null,
		areaM2,
		rooms,
		floor,
		district: null,
		address,
		description: description ? description.slice(0, 2000) : null,
		heatingType: null,
		propertyType: propertyTypeFromListingUrl(url),
		features: JSON.stringify({ private_owner: true }),
		lat: num(geo.latitude),
		lng: num(geo.longitude),
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
		title: listing.title,
		areaM2: listing.areaM2,
		rooms: listing.rooms,
		floor: listing.floor,
	};
	saveDetailCache(cache);

	return listing;
}

export const adresowoAdapter: CheerioAdapter = {
	id: "adresowo",
	name: "Adresowo - Małopolska + Śląsk direct-owner real estate",
	kind: "cheerio",
	startUrls: REGIONS.flatMap((region) => {
		const code = REGION_CODES[region.name];
		return code
			? CATEGORIES.map((category) => `${BASE}/${category}/${code}`)
			: [];
	}),
	maxRequestsPerCrawl: 800,
	// One list per category/region plus a small detail budget each.
	firstPageOnlyRequests:
		REGIONS.length * CATEGORIES.length * (1 + DETAIL_BUDGET_PER_PAGE),

	async extractHtml(html, url, enqueue, root) {
		const $ = root as unknown as Selector;
		const path = new URL(url).pathname;

		if (path.startsWith("/o/")) {
			const listing = detailToListing(html, url, $);
			return listing ? [listing] : [];
		}

		const listings: Listing[] = [];
		$("[data-offer-card]").each((_, el) => {
			const card = $(el) as CheerioSelection;
			const listing = cardToListing(card, url);
			if (listing) listings.push(listing);
		});

		// One detail fetch per uncached offer, capped per list page so the
		// backlog drains over runs instead of crowding out pagination.
		const cache = loadDetailCache();
		const detailUrls: string[] = [];
		for (const listing of listings) {
			const cached = cache[listing.externalId];
			if (cached) {
				// A previous run already enriched this offer; re-apply the
				// detail fields so a list-only crawl cannot wipe them.
				listing.lat = cached.lat ?? listing.lat;
				listing.lng = cached.lng ?? listing.lng;
				listing.address = cached.address ?? listing.address;
				listing.description = cached.description ?? listing.description;
				listing.title = cached.title ?? listing.title;
				listing.areaM2 = cached.areaM2 ?? listing.areaM2;
				listing.rooms = cached.rooms ?? listing.rooms;
				listing.floor = cached.floor ?? listing.floor;
				continue;
			}
			if (detailUrls.length >= DETAIL_BUDGET_PER_PAGE) break;
			detailUrls.push(listing.url);
		}
		if (detailUrls.length > 0) await enqueue(detailUrls);

		const pageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
		if (!pageOnly) {
			const next = $('link[rel="next"]').eq(0).attr("href");
			const nextUrl = absoluteUrl(next);
			if (nextUrl) await enqueue([nextUrl]);
		}

		return listings;
	},
};
