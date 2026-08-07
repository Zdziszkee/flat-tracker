import type { Page } from "playwright";

/**
 * Minimal structural view of a Cheerio selection. Crawlee passes its own
 * bundled cheerio build into request handlers; typing against a structural
 * subset keeps adapters compatible with any cheerio version.
 */
export interface CheerioSelection {
	(selector: string): CheerioSelection;
	text(): string;
	attr(name: string): string | undefined;
	find(selector: string): CheerioSelection;
	each(fn: (index: number, element: unknown) => void): CheerioSelection;
}

/** A normalized flat listing produced by any site adapter. */
export interface Listing {
	source: string;
	/** Portal-specific stable ad id (otodom id, olx id). */
	externalId: string;
	url: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
	district: string | null;
	lat: number | null;
	lng: number | null;
	/** When the ad was created on the portal, ISO string or null. */
	listedAt: string | null;
	scrapedAt: string;
}

/** Common configuration shared by every adapter. */
interface AdapterBase {
	id: string;
	name: string;
	/** URLs the crawl starts from. */
	startUrls: string[];
	/** Hard cap on pages per run. */
	maxRequestsPerCrawl?: number;
	/**
	 * Only keep listings created at or after this ISO date. List pages are
	 * sorted newest-first, so adapters stop paginating once a page is fully
	 * older than `since`.
	 */
	since?: string;
}

/**
 * A single crawl request handler. Adapters implement exactly one of the
 * three extraction strategies below.
 */
export interface CheerioAdapter extends AdapterBase {
	kind: "cheerio";
	/**
	 * Strategy A: DOM-based extraction. `parseListingCard` maps one element
	 * matched by `listingSelector` to a Listing (or null to skip).
	 * `nextPageSelector` optionally enqueues "next page" links.
	 */
	listingSelector?: string;
	nextPageSelector?: string;
	parseListingCard?: ($: CheerioSelection, el: unknown) => Listing | null;
	/**
	 * Strategy B: whole-page extraction from raw HTML. Used by sites that
	 * embed structured JSON (otodom __NEXT_DATA__, olx __PRERENDERED_STATE__).
	 * `enqueue` accepts additional URLs to crawl (detail pages, page 2...).
	 */
	extractHtml?: (
		html: string,
		url: string,
		enqueue: (urls: string[]) => void | Promise<void>,
	) => Promise<Listing[]>;
}

export interface PlaywrightAdapter extends AdapterBase {
	kind: "playwright";
	/** Selector to wait for before extracting. */
	listingSelector: string;
	/** Extract all listings from a fully rendered page. */
	extractListings(page: Page): Promise<Listing[]>;
}

export type SiteAdapter = CheerioAdapter | PlaywrightAdapter;
