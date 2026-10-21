import type { PropertyKind } from "#/lib/property-kind";
import type { CheerioAdapter, Listing } from "../types.ts";
import { formatAddressForGeocode } from "./address.ts";
import { findLdNodes } from "./ldjson.ts";
import { propertyTypeFromValue } from "./property-type.ts";

/**
 * Factory for portals that embed their offer feed as schema.org LD+JSON
 * (Morizon and Gratka share the same feed and markup).
 */
export interface LdOfferConfig {
	id: string;
	name: string;
	/**
	 * Search base URLs, one per covered region. Every start URL gets its own
	 * first page and paginates inside its own voivodeship (page N of the
	 * region the crawled URL belongs to, not of the first base).
	 */
	startUrls: string[];
	/** Query param for pagination (e.g. "page", "PageNumber", "p"). */
	pageParam: string;
	/** First page index appended after the param (1 for page=1, 2 for p=2...). */
	firstPage?: number;
	maxRequestsPerCrawl?: number;
	/** Turn one Offer node into a normalized Listing, or null to skip. */
	offerToListing(offer: Record<string, unknown>): Listing | null;
	/**
	 * Card-level posting dates keyed by canonical offer path. Morizon and
	 * Gratka publish "Dodane: YYYY.MM.DD" in the result card, not in the
	 * schema.org Offer node, so the factory merges these in after mapping.
	 */
	dateFromHtml?: (html: string) => Map<string, string>;
}

/** Structured street info commonly found on Offer.itemOffered.address. */
export interface OfferAddress {
	streetAddress?: unknown;
	addressLocality?: unknown;
}

export function ldOfferAddress(offer: Record<string, unknown>): OfferAddress {
	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const address = (item.address ?? {}) as Record<string, unknown>;
	return {
		streetAddress: address.streetAddress,
		addressLocality: address.addressLocality,
	};
}

/**
 * Morizon/Gratka's `addressLocality` is a Kraków district for Kraków rows
 * ("Mistrzejowice") but a town for everything else ("Wieliczka"). The offer
 * URL carries the city slug, so it decides which reading applies; without
 * this, every out-of-town house was geocoded as "..., Kraków".
 */
export function offerGeocodeAddress(
	offerUrl: string,
	street: string | null,
	number: string | undefined,
	locality: string | null,
): string | null {
	const inKrakow = isKrakowOfferUrl(offerUrl);
	if (street) {
		if (!inKrakow) {
			return formatAddressForGeocode(street, number, null, locality);
		}
		const district =
			locality && locality.toLowerCase() !== "kraków" ? locality : null;
		return formatAddressForGeocode(street, number, district, "Kraków");
	}
	if (!locality) return null;
	return inKrakow
		? formatAddressForGeocode(locality, undefined, null, "Kraków")
		: formatAddressForGeocode(locality, undefined, null, null);
}

/** The offer slug carries the city ("...-krakow-...", "...-wielicki-..."). */
export function isKrakowOfferUrl(offerUrl: string): boolean {
	return /[-/]krakow[-/]/iu.test(offerUrl);
}

/** Schema.org `itemOffered.@type` -> the three UI kinds. */
export function ldOfferPropertyType(
	offer: Record<string, unknown>,
): PropertyKind | null {
	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	return propertyTypeFromValue(item["@type"]);
}

/**
 * "Dodane: 2026.08.26" cards, keyed by the offer URL path they belong to.
 * The date lives at the bottom of each result card; the card's offer anchor
 * is the nearest preceding offer-like href.
 */
export function extractDodaneDates(html: string): Map<string, string> {
	const dates = new Map<string, string>();
	const re = /Dodane:\s*(\d{4})\.(\d{2})\.(\d{2})/g;
	for (const match of html.matchAll(re)) {
		const before = html.slice(
			Math.max(0, (match.index ?? 0) - 12_000),
			match.index,
		);
		const hrefs = [...before.matchAll(/href="([^"]+)"/g)];
		for (let i = hrefs.length - 1; i >= 0; i--) {
			const href = hrefs[i][1];
			if (!href || !/(?:\/oferta\/|\/nieruchomosci\/)/.test(href)) continue;
			const path = canonicalPath(href);
			if (path) {
				dates.set(path, `${match[1]}-${match[2]}-${match[3]}T00:00:00`);
			}
			break;
		}
	}
	return dates;
}

function canonicalPath(url: string): string | null {
	try {
		return new URL(url, "https://placeholder.invalid").pathname;
	} catch {
		return null;
	}
}

export function makeLdOfferAdapter(cfg: LdOfferConfig): CheerioAdapter {
	const firstPage = cfg.firstPage ?? 1;
	return {
		id: cfg.id,
		name: cfg.name,
		kind: "cheerio",
		startUrls: cfg.startUrls,
		maxRequestsPerCrawl: cfg.maxRequestsPerCrawl ?? 30,
		// One newest page per region must fit the first-page-only budget.
		firstPageOnlyRequests: cfg.startUrls.length,

		async extractHtml(html, url, enqueue) {
			const offers = extractOfferNodes(html);
			const postedDates = cfg.dateFromHtml?.(html);
			const listings: Listing[] = [];
			for (const offer of offers) {
				const listing = cfg.offerToListing(offer);
				if (!listing) continue;
				if (!listing.listedAt && postedDates) {
					const path = canonicalPath(listing.url);
					const postedAt = path ? postedDates.get(path) : undefined;
					if (postedAt) listing.listedAt = postedAt;
				}
				listings.push(listing);
			}

			// Pagination: ?pageParam=N, starting at `firstPage`. The base is the
			// crawled URL, so each region continues its own list. A
			// first-page-only run must not enqueue page 2: the request cap is
			// also the detail/date budget.
			const pageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
			if (!pageOnly) {
				const current = matchPage(url, cfg.pageParam) ?? firstPage;
				const next = new URL(url);
				next.searchParams.set(cfg.pageParam, String(current + 1));
				await enqueue([next.toString()]);
			}

			return listings;
		},
	};
}

function extractOfferNodes(html: string): Array<Record<string, unknown>> {
	// Parse ld+json blocks from raw HTML (our findLdNodes works on parsed
	// JSON, so parse here and search).
	const blocks: unknown[] = [];
	const re =
		/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
	for (const m of html.matchAll(re)) {
		try {
			blocks.push(JSON.parse(m[1].trim()));
		} catch {
			// skip malformed
		}
	}
	return findLdNodes(
		blocks,
		(n) =>
			n["@type"] === "Offer" &&
			typeof n.url === "string" &&
			n.price !== undefined,
	);
}

function matchPage(url: string, param: string): number | null {
	const m = url.match(new RegExp(`[?&]${param}=(\\d+)`));
	return m ? Number.parseInt(m[1], 10) : null;
}

export function num(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const n = Number.parseFloat(value.replace(/[\s,]/g, ""));
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

export function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}
