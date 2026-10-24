import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REGIONS } from "../regions.ts";
import type { Listing } from "../types.ts";
import {
	formatAddressForGeocode,
	minedStreetLooksReal,
	parseAddressFromText,
} from "./address.ts";
import { findLdNodes, makeLdGraphAdapter } from "./ldgraph.ts";
import { num, str } from "./ldoffer.ts";
import {
	propertyTypeFromListingUrl,
	propertyTypeFromValue,
} from "./property-type.ts";

/**
 * Detail pages are the only place this portal publishes the posting date
 * (`datePosted`) and coordinates. A list row is enriched by a small,
 * persistent detail pass: at most a few uncached details per list page, so
 * pagination keeps its budget and every run fills a bit of the backlog.
 */
const DETAIL_BUDGET_PER_PAGE = 8;

interface CachedDetail {
	listedAt: string | null;
	fetchedAt: string;
}

let detailCacheState: Record<string, CachedDetail> | null = null;

function detailCachePath(): string {
	return (
		process.env.NIERUCHOMOSCI_ONLINE_DETAIL_CACHE ??
		"data/crawler/nieruchomosci-online-details.json"
	);
}

function loadDetailCache(): Record<string, CachedDetail> {
	if (detailCacheState) return detailCacheState;
	let parsed: Record<string, Partial<CachedDetail>> = {};
	try {
		parsed = JSON.parse(readFileSync(detailCachePath(), "utf8"));
	} catch {
		// Missing or corrupt cache: start empty, details simply re-fetch.
	}
	const cache: Record<string, CachedDetail> = {};
	for (const [id, entry] of Object.entries(parsed)) {
		cache[id] = {
			listedAt: entry.listedAt ?? null,
			fetchedAt: entry.fetchedAt ?? "",
		};
	}
	detailCacheState = cache;
	return cache;
}

function saveDetailCache(cache: Record<string, CachedDetail>): void {
	const path = detailCachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cache));
}

function externalIdOf(url: string): string {
	return url.match(/(\d+)\.html/)?.[1] ?? url;
}

/**
 * Nieruchomosci-online embeds its results as a CollectionPage LD+JSON
 * block whose mainEntity.offers[0].offers is the listing array.
 */
export const nieruchomosciOnlineAdapter = makeLdGraphAdapter({
	id: "nieruchomosci-online",
	name: "Nieruchomosci-online - Małopolska + Śląsk real estate for sale",
	startUrls: REGIONS.flatMap((r) => [
		`https://www.nieruchomosci-online.pl/szukaj.html?3,mieszkanie,sprzedaz,${r.name},,,`,
		`https://www.nieruchomosci-online.pl/szukaj.html?1,dom,sprzedaz,${r.name},,,`,
		`https://www.nieruchomosci-online.pl/szukaj.html?2,dzialka,sprzedaz,${r.name},,,`,
	]),
	maxRequestsPerCrawl: 140,
	// The hourly run spends one request per category/region plus a few
	// detail pages; details fill dates and coordinates over successive runs.
	firstPageOnlyRequests:
		REGIONS.length * 3 + REGIONS.length * 3 * DETAIL_BUDGET_PER_PAGE,
	// Pagination: &p=N (the first result page has no p param).
	pageParam: "p",
	findNodes: (nodes) =>
		findLdNodes(
			nodes,
			(node) =>
				node["@type"] === "Offer" &&
				typeof node.url === "string" &&
				node.price !== undefined,
		),
	toListing: (offer, pageUrl) => offerToListing(offer, pageUrl),
	detail: {
		isDetailUrl: (url) => !/\/szukaj\.html/u.test(url),
		findNode: (nodes) => {
			const matches = findLdNodes(
				nodes,
				(node) =>
					typeof node.datePosted === "string" &&
					node.offers !== undefined &&
					(typeof node.url === "string" || node.address !== undefined),
			);
			return matches[0] ?? null;
		},
		toListing: (node, url) => detailToListing(node, url),
		enqueueFrom: (listings) => {
			const cache = loadDetailCache();
			const urls: string[] = [];
			for (const listing of listings) {
				const cached = cache[listing.externalId];
				if (cached) {
					if (!listing.listedAt) listing.listedAt = cached.listedAt;
					continue;
				}
				urls.push(listing.url);
				if (urls.length >= DETAIL_BUDGET_PER_PAGE) break;
			}
			return urls;
		},
	},
});

/**
 * The search URL starts with a numeric category (`?1,dom`, `?2,dzialka`,
 * `?3,mieszkanie`). It is the only type signal when the schema.org item is
 * the generic "Accommodation" and the listing slug omits the category.
 */
function kindFromSearchUrl(url: string): "apartment" | "house" | "plot" | null {
	const query = new URL(url).search;
	if (/^\?1,/.test(query)) return "house";
	if (/^\?2,/.test(query)) return "plot";
	if (/^\?3,/.test(query)) return "apartment";
	return null;
}

function offerToListing(
	offer: Record<string, unknown>,
	pageUrl: string,
): Listing | null {
	const url = str(offer.url);
	const price = num(offer.price);
	const spec = (offer.priceSpecification ?? {}) as Record<string, unknown>;
	const pricePerM2 = num(spec.price);
	if (!url || price === null) return null;

	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const description = str(item.description) ?? "";
	const area = extractArea(description);
	const rooms = extractRooms(description);
	const parsed = parseAddressFromText(description);
	const structured = (item.address ?? {}) as Record<string, unknown>;
	const street = str(structured.streetAddress);
	const locality = str(structured.addressLocality);
	const parsedMatchesStreet =
		parsed != null &&
		street != null &&
		parsed.street.trim().toLowerCase() === street.trim().toLowerCase();
	const plausibleParsed =
		parsed != null && minedStreetLooksReal(parsed.street) ? parsed : null;
	const address = street
		? formatAddressForGeocode(
				street,
				parsedMatchesStreet ? parsed.number : undefined,
				null,
				locality,
			)
		: plausibleParsed
			? formatAddressForGeocode(
					plausibleParsed.street,
					plausibleParsed.number,
					null,
					locality,
				)
			: locality
				? formatAddressForGeocode(locality, undefined, null, null)
				: null;

	// No title in the feed; derive a readable one from the description.
	const title =
		description.split(".")[0]?.slice(0, 120) || "Mieszkanie na sprzedaż";
	const itemFeatures = additionalProperties(item);

	return {
		source: "nieruchomosci-online",
		externalId: url.match(/(\d+)\.html/)?.[1] ?? url,
		url,
		title,
		price,
		pricePerM2,
		areaM2: area,
		rooms,
		floor: null,
		district: null,
		address,
		description: description || null,
		heatingType: null,
		propertyType: propertyTypeFromListingUrl(url) ?? kindFromSearchUrl(pageUrl),
		features:
			itemFeatures.length > 0 || locality || street
				? JSON.stringify({
						...Object.fromEntries(
							itemFeatures.map((property) => [
								property.name.toLowerCase().replace(/\s+/gu, "_"),
								property.value,
							]),
						),
						...(locality ? { city: locality } : {}),
						...(street ? { street } : {}),
						...(str(structured.addressRegion)
							? { voivodeship: str(structured.addressRegion) }
							: {}),
						...(str(structured.postalCode)
							? { postal_code: str(structured.postalCode) }
							: {}),
					})
				: null,
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

function extractArea(description: string): number | null {
	const match = description.match(/(\d+[.,]?\d*)\s*m[²2]/i);
	return match ? Number.parseFloat(match[1].replace(",", ".")) : null;
}

function extractRooms(description: string): number | null {
	const match = description.match(/(\d+)-pokojow/i);
	return match ? Number.parseInt(match[1], 10) : null;
}

/** "2026-09-02CEST11:47:43Z" / "2026-09-02" -> wall-clock ISO. */
function parseDatePosted(value: string): string | null {
	const stamped = value.match(
		/^(\d{4})-(\d{2})-(\d{2})(?:CEST|CET)?(\d{2}):(\d{2}):(\d{2})Z?$/u,
	);
	if (stamped) {
		return `${stamped[1]}-${stamped[2]}-${stamped[3]}T${stamped[4]}:${stamped[5]}:${stamped[6]}`;
	}
	if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T00:00:00`;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The detail page's schema.org property node as a Listing. */
function detailToListing(
	node: Record<string, unknown>,
	url: string,
): Listing | null {
	const externalId = externalIdOf(url);
	const rawOffers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
	const offers = (rawOffers ?? {}) as Record<string, unknown>;
	const spec = (offers.priceSpecification ?? {}) as Record<string, unknown>;
	const price = num(offers.price);
	if (price === null) return null;

	const address = (node.address ?? {}) as Record<string, unknown>;
	const street = str(address.streetAddress);
	const locality = str(address.addressLocality);
	const geo = (node.geo ?? {}) as Record<string, unknown>;
	const area = detailArea(node);
	const description = cleanDetailText(str(node.description));
	const listedAt =
		typeof node.datePosted === "string"
			? parseDatePosted(node.datePosted)
			: null;

	const listing: Listing = {
		source: "nieruchomosci-online",
		externalId,
		url,
		title: str(node.name) ?? "Nieruchomość na sprzedaż",
		price,
		pricePerM2: num(spec.price),
		areaM2: area,
		rooms: num(node.numberOfRooms),
		floor: str(node.floorLevel),
		district: null,
		address:
			street && locality
				? formatAddressForGeocode(street, undefined, null, locality)
				: (street ?? locality ?? null),
		description,
		heatingType: null,
		propertyType:
			propertyTypeFromValue(node["@type"]) ?? propertyTypeFromListingUrl(url),
		features: detailFeatures(node),
		lat: num(geo.latitude),
		lng: num(geo.longitude),
		listedAt,
		scrapedAt: new Date().toISOString(),
		offerType: "sale",
		pricePeriod: null,
	};

	const cache = loadDetailCache();
	cache[externalId] = {
		listedAt,
		fetchedAt: new Date().toISOString(),
	};
	saveDetailCache(cache);
	return listing;
}

function detailArea(node: Record<string, unknown>): number | null {
	const size = (node.floorSize ?? {}) as Record<string, unknown>;
	const direct = num(size.value);
	if (direct !== null) return direct;
	for (const property of additionalProperties(node)) {
		if (/^(?:land|house|floor) area$|powierzchnia/iu.test(property.name)) {
			const value = num(property.value);
			if (value !== null) return value;
		}
	}
	return null;
}

function additionalProperties(
	node: Record<string, unknown>,
): Array<{ name: string; value: unknown }> {
	const raw = node.additionalProperty;
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(entry): entry is Record<string, unknown> =>
				typeof entry === "object" && entry !== null,
		)
		.map((entry) => ({
			name: str(entry.name) ?? "",
			value: entry.value,
		}))
		.filter((entry) => entry.name.length > 0);
}

/** Promote the attributes db-sink knows how to turn into columns. */
function detailFeatures(node: Record<string, unknown>): string | null {
	const features: Record<string, unknown> = {};
	for (const property of additionalProperties(node)) {
		const key = property.name.toLowerCase().replace(/\s+/gu, "_");
		if (/^year built$/iu.test(property.name)) {
			features.build_year = num(property.value);
		} else if (/^total floors in building$/iu.test(property.name)) {
			features.building_floors_num = num(property.value);
		} else if (/^building type$/iu.test(property.name)) {
			features.building_type = str(property.value);
		} else {
			features[key] = property.value;
		}
	}
	const address = (node.address ?? {}) as Record<string, unknown>;
	const city = str(address.addressLocality);
	const region = str(address.addressRegion);
	const postalCode = str(address.postalCode);
	const street = str(address.streetAddress);
	if (city) features.city = city;
	if (region) features.voivodeship = region;
	if (postalCode) features.postal_code = postalCode;
	if (street) features.street = street;
	const floor = str(node.floorLevel);
	if (floor) features.floor = floor;
	const agent = (node.agent ?? {}) as Record<string, unknown>;
	const agentName = str(agent.name);
	const agentType = str(agent["@type"]);
	if (
		agentName &&
		agentType &&
		/realestateagent|organization/iu.test(agentType)
	) {
		features.agency = agentName;
	}
	const images = node.image;
	if (Array.isArray(images)) {
		features.image_count = images.length;
		features.primary_image =
			images.find((entry): entry is string => typeof entry === "string") ??
			null;
	} else if (typeof images === "string") {
		features.image_count = 1;
		features.primary_image = images;
	}
	return Object.keys(features).length > 0 ? JSON.stringify(features) : null;
}

function cleanDetailText(value: string | null): string | null {
	if (!value) return null;
	const text = value
		.replace(/&lt;br\s*\/?&gt;/giu, " ")
		.replace(/<br\s*\/?>/giu, " ")
		.replace(/&nbsp;/giu, " ")
		.replace(/&[a-z]+;/giu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return text || null;
}
