import { REGIONS } from "../regions.ts";
import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";
import { formatAddressForGeocode, parseAddressFromText } from "./address.ts";
import { createDetailCache, enqueueDetailPass } from "./detail-cache.ts";
import { withHarvestedAttributes } from "./html-attributes.ts";
import { cleanText } from "./html-entities.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { num, str } from "./ldoffer.ts";
import { absoluteUrl, areaFromText, priceFromText } from "./parse.ts";
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
	/** Every labelled value the detail page printed (see html-attributes.ts). */
	features: string | null;
}

const detailCache = createDetailCache<CachedDetail>({
	path: "data/crawler/adresowo-details.json",
	normalize: (entry) => ({
		fetchedAt: typeof entry.fetchedAt === "string" ? entry.fetchedAt : "",
		lat: typeof entry.lat === "number" ? entry.lat : null,
		lng: typeof entry.lng === "number" ? entry.lng : null,
		address: typeof entry.address === "string" ? entry.address : null,
		description:
			typeof entry.description === "string" ? entry.description : null,
		title: typeof entry.title === "string" ? entry.title : null,
		areaM2: typeof entry.areaM2 === "number" ? entry.areaM2 : null,
		rooms: typeof entry.rooms === "number" ? entry.rooms : null,
		floor: typeof entry.floor === "string" ? entry.floor : null,
		features: typeof entry.features === "string" ? entry.features : null,
	}),
});

function externalIdOf(url: string): string {
	try {
		return new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
	} catch {
		return url;
	}
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
	const url = absoluteUrl(link.attr("href"), BASE);
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
			advertiser_type: "private",
			list_page: pageUrl,
			list_description: listDescription,
			...(city ? { city } : {}),
			...(district ? { district } : {}),
			...(street ? { street } : {}),
			...(propertyType === "plot" && areaM2 != null
				? { plot_area: areaM2 }
				: {}),
		}),
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

/**
 * The detail page prints its facts as chips whose label comes *after* the
 * value ("1960 | rok budowy", "parter", "brak windy") plus a building-material
 * icon code, so a selector per chip is fragile. The visible text is stable and
 * short, and these are the facts it carries.
 */
function detailChips(html: string): {
	buildYear: number | null;
	buildingMaterial: string | null;
	hasElevator: boolean | null;
	floor: string | null;
} {
	const text =
		cleanText(
			html
				.replace(/<script[\s\S]*?<\/script>/giu, " ")
				.replace(/<style[\s\S]*?<\/style>/giu, " ")
				.replace(/<[^>]+>/gu, " | "),
		) ?? "";
	const year = text.match(/(\d{4})[\s|]*rok budowy/iu);
	const material = html.match(
		/construction-(brick|panel|wood|concrete|silicate)/iu,
	);
	const floorMatch = text.match(/\b(parter|\d+\s*pi[eę]tr\w*)\b/iu);
	return {
		buildYear: year ? Number.parseInt(year[1], 10) : null,
		buildingMaterial: material ? material[1].toLowerCase() : null,
		hasElevator: /brak windy/iu.test(text)
			? false
			: /\bwinda\b/iu.test(text)
				? true
				: null,
		floor: floorMatch ? floorMatch[1].replace(/\s+/gu, " ") : null,
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
		absoluteUrl($('link[rel="canonical"]').eq(0).attr("href"), BASE) ?? url;
	const propertyType = propertyTypeFromListingUrl(url);

	const chips = detailChips(html);
	const listing: Listing = {
		source: "adresowo",
		externalId: externalIdOf(url),
		url: canonical,
		title: title.slice(0, 240),
		price,
		pricePerM2: price && areaM2 ? price / areaM2 : null,
		areaM2,
		rooms,
		floor: floor ?? chips.floor,
		district: null,
		address,
		description: description ?? null,
		heatingType: null,
		propertyType,
		features: JSON.stringify(
			withHarvestedAttributes(
				{
					private_owner: true,
					advertiser_type: "private",
					...(chips.buildYear != null ? { build_year: chips.buildYear } : {}),
					...(chips.buildingMaterial
						? { building_material: chips.buildingMaterial }
						: {}),
					...(chips.hasElevator != null
						? { has_elevator: chips.hasElevator }
						: {}),
					...(propertyType === "plot" && areaM2 != null
						? { plot_area: areaM2 }
						: {}),
				},
				html,
			),
		),
		lat: num(geo.latitude),
		lng: num(geo.longitude),
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};

	detailCache.store(listing.externalId, {
		lat: listing.lat,
		lng: listing.lng,
		address: listing.address,
		description: listing.description,
		title: listing.title,
		areaM2: listing.areaM2,
		rooms: listing.rooms,
		floor: listing.floor,
		features: listing.features,
	});

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
		const detailUrls = enqueueDetailPass(listings, detailCache.load(), {
			budget: DETAIL_BUDGET_PER_PAGE,
			// A previous run already enriched this offer; re-apply the detail
			// fields so a list-only crawl cannot wipe them.
			apply: (listing, cached) => {
				listing.lat = cached.lat ?? listing.lat;
				listing.lng = cached.lng ?? listing.lng;
				listing.address = cached.address ?? listing.address;
				listing.description = cached.description ?? listing.description;
				listing.title = cached.title ?? listing.title;
				listing.areaM2 = cached.areaM2 ?? listing.areaM2;
				listing.rooms = cached.rooms ?? listing.rooms;
				listing.floor = cached.floor ?? listing.floor;
				// The detail pass is the only place these labels are read; a
				// cached entry keeps them for the next list-only run.
				if (cached.features) {
					const base = listing.features
						? (JSON.parse(listing.features) as Record<string, unknown>)
						: {};
					listing.features = JSON.stringify({
						...base,
						...(JSON.parse(cached.features) as Record<string, unknown>),
					});
				}
			},
		});
		if (detailUrls.length > 0) await enqueue(detailUrls);

		const pageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
		if (!pageOnly) {
			const next = $('link[rel="next"]').eq(0).attr("href");
			const nextUrl = absoluteUrl(next, BASE);
			if (nextUrl) await enqueue([nextUrl]);
		}

		return listings;
	},
};
