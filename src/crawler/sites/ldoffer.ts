import type { CheerioAdapter, Listing } from "../types.ts";
import { findLdNodes } from "./ldjson.ts";

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
			const listings: Listing[] = [];
			for (const offer of offers) {
				const listing = cfg.offerToListing(offer);
				if (listing) listings.push(listing);
			}

			// Pagination: ?pageParam=N, starting at `firstPage`. The base is the
			// crawled URL, so each region continues its own list.
			const current = matchPage(url, cfg.pageParam) ?? firstPage;
			const next = new URL(url);
			next.searchParams.set(cfg.pageParam, String(current + 1));
			await enqueue([next.toString()]);

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
