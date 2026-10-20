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
	findNodes(nodes: unknown[]): Array<Record<string, unknown>>;
	toListing(node: Record<string, unknown>): Listing | null;
}

export function makeLdGraphAdapter(cfg: LdGraphConfig): CheerioAdapter {
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
			const nodes = parseLdJson(html);
			const listings: Listing[] = [];
			for (const node of cfg.findNodes(nodes)) {
				const listing = cfg.toListing(node);
				if (listing) listings.push(listing);
			}

			// The crawled URL is the base, so each region continues its own
			// pagination instead of jumping back to the first region.
			const current = Number.parseInt(
				new URL(url).searchParams.get(cfg.pageParam) ?? String(firstPage),
				10,
			);
			const next = new URL(url);
			next.searchParams.set(cfg.pageParam, String(current + 1));
			await enqueue([next.toString()]);

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
