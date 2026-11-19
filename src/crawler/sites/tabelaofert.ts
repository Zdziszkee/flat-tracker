import { REGIONS } from "../regions.ts";
import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";
import { createDetailCache, type DetailCacheEntry } from "./detail-cache.ts";
import { cleanText } from "./html-entities.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { num, str } from "./ldoffer.ts";
import { absoluteUrl } from "./parse.ts";
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
/**
 * Detail pages a first-page-only run may follow per list page. Investment
 * and direct-offer pages share the budget; `TABELAOFERT_DETAIL_BUDGET` raises
 * it for a one-off drain of a fresh database (the list rows carry no geo).
 */
const detailBudgetPerPage = (): number => {
	const raw = Number(process.env.TABELAOFERT_DETAIL_BUDGET);
	return Number.isFinite(raw) && raw >= 0 ? raw : 8;
};
// Unit inventory changes as flats sell; a short TTL also lets a reset DB
// recover the detail rows without waiting a month.
const DETAIL_TTL_DAYS = 3;
const DETAIL_CACHE_PATH = "data/crawler/tabelaofert-investments.json";
const CATEGORIES = ["mieszkania", "domy", "dzialki"] as const;

type Selector = (selector: string | unknown) => CheerioSelection;

const detailCache = createDetailCache<DetailCacheEntry>({
	path: DETAIL_CACHE_PATH,
	ttlDays: DETAIL_TTL_DAYS,
	normalize: (entry) => ({
		fetchedAt: typeof entry.fetchedAt === "string" ? entry.fetchedAt : "",
	}),
});

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

/**
 * A single offer page (`/oferta/...`). The list page carries the direct
 * offers without coordinates or an address; only this page has them, so it
 * needs its own detail pass (gated by the same TTL cache).
 */
function isOfferUrl(url: string): boolean {
	try {
		return new URL(url).pathname.startsWith("/oferta/");
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
function quarterStart(label: string | null): string | null {
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
	/**
	 * The page's shared place. On an investment page every unit offer points
	 * its `geo`/`address` at `#geo`/`#adres` (`{"@id": "#geo"}`); only the
	 * first one inlines the coordinates, so reading `itemOffered.geo` alone
	 * left every unit except the first without a map point.
	 */
	place: PagePlace | null;
}

interface PagePlace {
	lat: number | null;
	lng: number | null;
	street: string | null;
	city: string | null;
	district: string | null;
	voivodeship: string | null;
	address: string | null;
}

/** First numeric geo and first postal address anywhere in the LD+JSON nodes. */
function pagePlace(nodes: unknown[]): PagePlace | null {
	// A holder object, not two `let`s: TypeScript 6 narrows a `let` that only
	// the recursive closure assigns to its initializer (`null`), which made the
	// reads below resolve to `never`.
	const found: {
		geo: { lat: number | null; lng: number | null } | null;
		postal: {
			street: string | null;
			city: string | null;
			district: string | null;
			voivodeship: string | null;
		} | null;
	} = { geo: null, postal: null };
	const walk = (value: unknown): void => {
		if (!value || typeof value !== "object" || (found.geo && found.postal)) {
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry);
			return;
		}
		const obj = value as Record<string, unknown>;
		if (!found.geo) {
			const g = obj.geo as Record<string, unknown> | undefined;
			const lat = g && typeof g === "object" ? num(g.latitude) : null;
			const lng = g && typeof g === "object" ? num(g.longitude) : null;
			if (lat != null && lng != null) found.geo = { lat, lng };
		}
		if (!found.postal) {
			const a = obj.address as Record<string, unknown> | undefined;
			const street = a && typeof a === "object" ? str(a.streetAddress) : null;
			const locality =
				a && typeof a === "object" ? cleanText(str(a.addressLocality)) : null;
			if (street || locality) {
				found.postal = {
					street,
					city: locality?.split(",")[0]?.trim() ?? null,
					district: locality?.includes(",")
						? locality.split(",").slice(1).join(",").trim() || null
						: null,
					voivodeship:
						a && typeof a === "object" ? cleanText(str(a.addressRegion)) : null,
				};
			}
		}
		for (const entry of Object.values(obj)) walk(entry);
	};
	for (const node of nodes) walk(node);
	if (!found.geo && !found.postal) return null;
	return {
		lat: found.geo?.lat ?? null,
		lng: found.geo?.lng ?? null,
		street: found.postal?.street ?? null,
		city: found.postal?.city ?? null,
		district: found.postal?.district ?? null,
		voivodeship: found.postal?.voivodeship ?? null,
		address:
			[found.postal?.street, found.postal?.city].filter(Boolean).join(", ") ||
			null,
	};
}

function offerToListing(
	offer: Record<string, unknown>,
	context: OfferContext,
): Listing | null {
	const rawUrl = str(offer.url);
	const url = absoluteUrl(rawUrl, BASE);
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
	const street =
		str(addressNode.streetAddress) ?? context.place?.street ?? null;
	const placeLocality = [context.place?.city, context.place?.district]
		.filter(Boolean)
		.join(", ");
	const locality =
		cleanText(str(addressNode.addressLocality)) ?? (placeLocality || null);
	const city = locality?.split(",")[0]?.trim() ?? null;
	const voivodeship =
		cleanText(str(addressNode.addressRegion)) ??
		context.place?.voivodeship ??
		null;
	const district = locality?.includes(",")
		? locality.split(",").slice(1).join(",").trim() || null
		: (context.place?.district ?? null);
	const address =
		[street, locality].filter(Boolean).join(", ") ||
		context.place?.address ||
		null;
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
		description: description ?? null,
		heatingType: propertyValue(item.additionalProperty, "Ogrzewanie"),
		propertyType,
		features: JSON.stringify(features),
		lat: num(geo.latitude) ?? context.place?.lat ?? null,
		lng: num(geo.longitude) ?? context.place?.lng ?? null,
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
	nodes: unknown[],
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
		place: pagePlace(nodes),
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
		REGIONS.length * CATEGORIES.length * (1 + detailBudgetPerPage()),

	async extractHtml(html, url, enqueue, root) {
		const $ = root as unknown as Selector;
		const nodes = parseLdJson(html);
		const product = findProduct(nodes);
		const pagePath = new URL(url).pathname;
		const category = pagePath.split("/").filter(Boolean)[0] ?? null;

		if (isInvestmentUrl(url)) {
			// Investment detail: every offer is a unit for sale.
			const context = contextOf(product, url, category, nodes);
			const listings: Listing[] = [];
			for (const offer of productOffers(product)) {
				const listing = offerToListing(offer, context);
				if (listing) listings.push(listing);
			}
			if (context.investmentId) {
				detailCache.store(context.investmentId, {});
			}
			return listings;
		}

		if (isOfferUrl(url)) {
			// Direct offer detail: the list row has no geo or address, this page
			// has both. Marking it fetched keeps the list page from queueing it
			// again until the TTL expires.
			const context = contextOf(product, url, category, nodes);
			const listings: Listing[] = [];
			for (const offer of productOffers(product)) {
				const listing = offerToListing(offer, context);
				if (listing) listings.push(listing);
			}
			const offerId = listingId(url);
			if (offerId) detailCache.store(offerId, {});
			return listings;
		}

		// List page: direct offers are emitted now, investments are queued
		// for their unit-level detail page.
		const context = contextOf(product, url, category, nodes);
		const listings: Listing[] = [];
		const detailUrls: string[] = [];
		for (const offer of productOffers(product)) {
			const offerUrl = absoluteUrl(str(offer.url), BASE);
			if (!offerUrl) continue;
			if (isInvestmentUrl(offerUrl)) {
				const id = listingId(offerUrl);
				if (
					id &&
					!detailCache.fresh(detailCache.get(id)) &&
					detailUrls.length < detailBudgetPerPage()
				) {
					detailUrls.push(offerUrl);
				}
				continue;
			}
			const listing = offerToListing(offer, context);
			if (listing) {
				listings.push(listing);
				// The list row has no coordinates; spend a detail request on it
				// (bounded by the page budget) so the offer lands on the map.
				if (
					!detailCache.fresh(detailCache.get(listing.externalId)) &&
					detailUrls.length < detailBudgetPerPage()
				) {
					detailUrls.push(offerUrl);
				}
			}
		}
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
