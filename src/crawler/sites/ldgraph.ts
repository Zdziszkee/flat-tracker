import type { CheerioAdapter, Listing } from "../types.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";

/**
 * Generic LD+JSON listing adapter for portals whose feed is an `@graph` or
 * `CollectionPage` wrapper rather than a flat list of `Offer` nodes.
 * Pagination and parsing live here; each portal supplies only the node
 * predicate and the item -> Listing mapping.
 */
export interface LdGraphConfig {
	id: string;
	name: string;
	startUrls: string[];
	/** Query param for pagination (e.g. "PageNumber", "p"). */
	pageParam: string;
	/** First page index appended after the param (default 1). */
	firstPage?: number;
	maxRequestsPerCrawl?: number;
	/** Requests a first-page-only run may spend (list pages + details). */
	firstPageOnlyRequests?: number;
	findNodes(nodes: unknown[]): Array<Record<string, unknown>>;
	/** `pageUrl` is the crawled category page, used as a type hint when the
	 * schema.org node labels every property the same way. */
	toListing(node: Record<string, unknown>, pageUrl: string): Listing | null;
	/**
	 * Optional detail-page pass for feeds whose list rows omit the posting
	 * date. `enqueueFrom` returns a small number of uncached detail URLs per
	 * list page; a crawled detail page is parsed by `toListing` instead of
	 * the list predicate.
	 */
	detail?: {
		isDetailUrl(url: string): boolean;
		findNode(nodes: unknown[]): Record<string, unknown> | null;
		toListing(node: Record<string, unknown>, url: string): Listing | null;
		enqueueFrom(listings: Listing[], pageUrl: string): string[];
	};
}

export function makeLdGraphAdapter(cfg: LdGraphConfig): CheerioAdapter {
	const firstPage = cfg.firstPage ?? 1;
	return {
		id: cfg.id,
		name: cfg.name,
		kind: "cheerio",
		startUrls: cfg.startUrls,
		maxRequestsPerCrawl: cfg.maxRequestsPerCrawl ?? 30,
		firstPageOnlyRequests: cfg.firstPageOnlyRequests ?? cfg.startUrls.length,
		// One newest page per region must fit the first-page-only budget.

		async extractHtml(html, url, enqueue) {
			const nodes = parseLdJson(html);

			if (cfg.detail?.isDetailUrl(url)) {
				const node = cfg.detail.findNode(nodes);
				const listing = node ? cfg.detail.toListing(node, url) : null;
				return listing ? [listing] : [];
			}

			const listings: Listing[] = [];
			for (const node of cfg.findNodes(nodes)) {
				const listing = cfg.toListing(node, url);
				if (listing) listings.push(listing);
			}
			if (cfg.detail) {
				const detailUrls = cfg.detail.enqueueFrom(listings, url);
				if (detailUrls.length > 0) await enqueue(detailUrls);
			}

			// The crawled URL is the base, so each region continues its own
			// pagination instead of jumping back to the first region. A
			// first-page-only run must not enqueue page 2: the request cap is
			// also the detail/date budget.
			const pageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
			if (!pageOnly) {
				const current = Number.parseInt(
					new URL(url).searchParams.get(cfg.pageParam) ?? String(firstPage),
					10,
				);
				const next = new URL(url);
				next.searchParams.set(cfg.pageParam, String(current + 1));
				await enqueue([next.toString()]);
			}

			return listings;
		},
	};
}

/** Shared predicate for a `@type` that may be a string or an array. */
export function hasLdType(
	node: Record<string, unknown>,
	type: string,
): boolean {
	const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
	return types.includes(type);
}

/** Re-export so adapters keep one import for the common LD+JSON helpers. */
export { findLdNodes };
