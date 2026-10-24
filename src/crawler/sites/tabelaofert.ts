import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REGIONS } from "../regions.ts";
import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";
import { cleanText } from "./html-entities.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { num, str } from "./ldoffer.ts";
import {
	propertyTypeFromListingUrl,
	propertyTypeFromValue,
} from "./property-type.ts";

/**
 * TabelaOfert.pl — a major new-development portal. The list pages
 * (`/mieszkania|domy|dzialki/<voivodeship>?page=N`) embed a schema.org
 * Product whose `offers.offers` are projects, plus occasional direct
 * single-property offers (especially plots).
 *
 * Investment detail pages (`/inwestycja/...,i<id>`) carry the real unit
 * inventory: `Product.offers.offers` is an array of unit offers with area,
 * rooms, floor, price, exact coordinates and the unit URL. We store one
 * row per unit (like investmap) rather than a project-level price range.
 *
 * Detail fetches are gated by a per-investment TTL cache, so the hourly
 * `firstPageOnly` run spends its small budget on new projects and the rest
 * of the inventory drains over subsequent runs / a manual full crawl.
 */

const BASE = "https://tabelaofert.pl";
const DETAIL_BUDGET_PER_PAGE = 8;
// Unit inventory changes as flats sell; a short TTL also lets a reset DB
// recover the detail rows without waiting a month.
const DETAIL_TTL_DAYS = 3;
const DETAIL_CACHE_PATH = "data/crawler/tabelaofert-investments.json";
const CATEGORIES = ["mieszkania", "domy", "dzialki"] as const;

type Selector = (selector: string | unknown) => CheerioSelection;

interface CachedInvestment {
	fetchedAt: string;
}

let cacheState: Record<string, CachedInvestment> | null = null;

function loadCache(): Record<string, CachedInvestment> {
	if (cacheState) return cacheState;
	let parsed: Record<string, Partial<CachedInvestment>> = {};
	try {
		parsed = JSON.parse(readFileSync(DETAIL_CACHE_PATH, "utf8"));
	} catch {
		// Missing or corrupt cache: start empty, details simply re-fetch.
	}
	const cache: Record<string, CachedInvestment> = {};
	for (const [id, entry] of Object.entries(parsed)) {
		cache[id] = { fetchedAt: entry.fetchedAt ?? "" };
	}
	cacheState = cache;
	return cache;
}

function saveCache(cache: Record<string, CachedInvestment>): void {
	mkdirSync(dirname(DETAIL_CACHE_PATH), { recursive: true });
	writeFileSync(DETAIL_CACHE_PATH, JSON.stringify(cache));
}

function cacheFresh(entry: CachedInvestment | undefined): boolean {
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

/** Last `,i<digits>`/`,<digits>` segment of a TabelaOfert listing URL. */
function listingId(url: string): string | null {
	return url.match(/,((?:i)?\d+)(?:\?|$)/u)?.[1] ?? null;
}

function isInvestmentUrl(url: string): boolean {
	try {
		return new URL(url).pathname.startsWith("/inwestycja/");
	} catch {
		return false;
	}
}

function numFromQuantity(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") return num(value);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return num(record.value) ?? num(record.minValue) ?? num(record.maxValue);
	}
	return null;
}

function propertyValue(properties: unknown, name: string): string | null {
	if (!Array.isArray(properties)) return null;
	for (const entry of properties) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (
			typeof record.name === "string" &&
			record.name.toLowerCase() === name.toLowerCase()
		) {
			return cleanText(str(record.value));
		}
	}
	return null;
}

function propertiesMap(value: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!Array.isArray(value)) return out;
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const name = cleanText(str(record.name));
		if (!name) continue;
		out[name.toLowerCase()] = record.value ?? true;
	}
	return out;
}

/** "IV kwartał 2026" / "I kw. 2026" -> quarter-start ISO date. */
export function quarterStart(label: string | null): string | null {
	if (!label) return null;
	const quarter = label.match(/\b(I|II|III|IV)\s*(?:kw|kwarta[łl])/iu)?.[1];
	const year = label.match(/\b(20\d{2})\b/u)?.[1];
	if (!quarter || !year) return null;
	const month = { I: 1, II: 4, III: 7, IV: 10 }[
		quarter.toUpperCase() as "I" | "II" | "III" | "IV"
	];
	return `${year}-${String(month).padStart(2, "0")}-01`;
}

interface OfferContext {
	investmentId: string | null;
	investmentTitle: string | null;
	developer: string | null;
	constructionEndLabel: string | null;
	constructionEndDate: string | null;
	sourceCategory: string | null;
	pageUrl: string;
}

function offerToListing(
	offer: Record<string, unknown>,
	context: OfferContext,
): Listing | null {
	const rawUrl = str(offer.url);
	const url = absoluteUrl(rawUrl);
	if (!url) return null;
	const externalId = listingId(url);
	if (!externalId) return null;

	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const addressNode = (item.address ?? {}) as Record<string, unknown>;
	const geo = (item.geo ?? {}) as Record<string, unknown>;
	const price = num(offer.price);
	const areaM2 = numFromQuantity(item.floorSize);
	const rooms = numFromQuantity(item.numberOfRooms);
	const floor = str(item.floorLevel);
	const street = str(addressNode.streetAddress);
	const locality = cleanText(str(addressNode.addressLocality));
	const city = locality?.split(",")[0]?.trim() ?? null;
	const voivodeship = cleanText(str(addressNode.addressRegion));
	const district = locality?.includes(",")
		? locality.split(",").slice(1).join(",").trim() || null
		: null;
	const address = [street, locality].filter(Boolean).join(", ") || null;
	const unitTitle = cleanText(str(offer.name));
	const investmentTitle = context.investmentTitle;
	const title = [investmentTitle, unitTitle].filter(Boolean).join(" — ");
	const description =
		cleanText(str(offer.description)) ??
		cleanText(str(item.description)) ??
		investmentTitle;

	const propertyType =
		propertyTypeFromListingUrl(url) ??
		propertyTypeFromValue(item["@type"]) ??
		propertyTypeFromListingUrl(context.pageUrl);

	const features: Record<string, unknown> = {
		...propertiesMap(item.additionalProperty),
		market: "pierwotny",
		investment_id: context.investmentId,
		investment_title: investmentTitle,
		developer: context.developer,
		construction_end_label: context.constructionEndLabel,
		construction_end_date: context.constructionEndDate,
		...(city ? { city } : {}),
		...(voivodeship ? { voivodeship } : {}),
		...(district ? { district } : {}),
		...(street ? { street } : {}),
		...(propertyType === "plot" && areaM2 != null ? { plot_area: areaM2 } : {}),
		advertiser_type: "developer",
	};

	return {
		source: "tabelaofert",
		externalId,
		url,
		title: (title || unitTitle || "Oferta TabelaOfert").slice(0, 240),
		price,
		pricePerM2: price && areaM2 ? price / areaM2 : null,
		areaM2,
		rooms,
		floor,
		district,
		address,
		description: description ? description.slice(0, 2000) : null,
		heatingType: propertyValue(item.additionalProperty, "Ogrzewanie"),
		propertyType,
		features: JSON.stringify(features),
		lat: num(geo.latitude),
		lng: num(geo.longitude),
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

function findProduct(nodes: unknown[]): Record<string, unknown> | null {
	return (
		findLdNodes(
			nodes,
			(node) =>
				node["@type"] === "Product" ||
				(Array.isArray(node["@type"]) &&
					(node["@type"] as unknown[]).includes("Product")),
		)[0] ?? null
	);
}

function productOffers(
	product: Record<string, unknown> | null,
): Array<Record<string, unknown>> {
	const aggregate = (product?.offers ?? {}) as Record<string, unknown>;
	const offers = aggregate.offers;
	return Array.isArray(offers)
		? offers.filter(
				(entry): entry is Record<string, unknown> =>
					!!entry && typeof entry === "object",
			)
		: [];
}

function contextOf(
	product: Record<string, unknown> | null,
	pageUrl: string,
	category: string | null,
): OfferContext {
	const brand = (product?.brand ?? {}) as Record<string, unknown>;
	const properties = product?.additionalProperty;
	const constructionEndLabel = propertyValue(properties, "Termin oddania");
	const title =
		cleanText(str(product?.name))?.replace(
			/\s*-\s*(mieszkania|domy|dzia[łl]ki) na sprzeda[żz].*$/iu,
			"",
		) ?? null;
	const pageInvestmentId = isInvestmentUrl(pageUrl) ? listingId(pageUrl) : null;
	const onInvestmentPage = pageInvestmentId !== null;
	return {
		investmentId: pageInvestmentId,
		// List pages call the Product "Domy małopolskie"; only an investment
		// detail page has a real project title to prefix unit rows with.
		investmentTitle: onInvestmentPage ? title : null,
		developer: onInvestmentPage ? cleanText(str(brand.name)) : null,
		constructionEndLabel: onInvestmentPage ? constructionEndLabel : null,
		constructionEndDate: onInvestmentPage
			? quarterStart(constructionEndLabel)
			: null,
		sourceCategory: category,
		pageUrl,
	};
}

export const tabelaofertAdapter: CheerioAdapter = {
	id: "tabelaofert",
	name: "TabelaOfert - Małopolska + Śląsk new developments (flats, houses, plots)",
	kind: "cheerio",
	startUrls: REGIONS.flatMap((region) =>
		CATEGORIES.map((category) => `${BASE}/${category}/${region.name}`),
	),
	maxRequestsPerCrawl: 1200,
	firstPageOnlyRequests:
		REGIONS.length * CATEGORIES.length * (1 + DETAIL_BUDGET_PER_PAGE),

	async extractHtml(html, url, enqueue, root) {
		const $ = root as unknown as Selector;
		const nodes = parseLdJson(html);
		const product = findProduct(nodes);
		const pagePath = new URL(url).pathname;
		const category = pagePath.split("/").filter(Boolean)[0] ?? null;

		if (isInvestmentUrl(url)) {
			// Investment detail: every offer is a unit for sale.
			const context = contextOf(product, url, category);
			const listings: Listing[] = [];
			for (const offer of productOffers(product)) {
				const listing = offerToListing(offer, context);
				if (listing) listings.push(listing);
			}
			if (context.investmentId) {
				const cache = loadCache();
				cache[context.investmentId] = {
					fetchedAt: new Date().toISOString(),
				};
				saveCache(cache);
			}
			return listings;
		}

		// List page: direct offers are emitted now, investments are queued
		// for their unit-level detail page.
		const context = contextOf(product, url, category);
		const listings: Listing[] = [];
		const cache = loadCache();
		const detailUrls: string[] = [];
		for (const offer of productOffers(product)) {
			const offerUrl = absoluteUrl(str(offer.url));
			if (!offerUrl) continue;
			if (isInvestmentUrl(offerUrl)) {
				const id = listingId(offerUrl);
				if (
					id &&
					!cacheFresh(cache[id]) &&
					detailUrls.length < DETAIL_BUDGET_PER_PAGE
				) {
					detailUrls.push(offerUrl);
				}
				continue;
			}
			const listing = offerToListing(offer, context);
			if (listing) listings.push(listing);
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
