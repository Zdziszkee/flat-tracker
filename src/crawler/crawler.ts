import {
	CheerioCrawler,
	Configuration,
	MemoryStorage,
	PlaywrightCrawler,
} from "crawlee";

import type { Listing, SiteAdapter } from "./types.ts";

export interface CrawlResult {
	listings: Listing[];
	pages: number;
}

/**
 * Run a crawl for a site adapter. Uses a real browser for JS-rendered
 * sites and plain HTTP + Cheerio for static ones, with the same output.
 */
export async function crawlSite(adapter: SiteAdapter): Promise<CrawlResult> {
	const listings: Listing[] = [];
	const config = new Configuration({ storageClient: new MemoryStorage() });

	const maxRequestsPerCrawl = adapter.maxRequestsPerCrawl ?? 100;

	if (adapter.kind === "playwright") {
		const crawler = new PlaywrightCrawler(
			{
				maxRequestsPerCrawl,
				maxConcurrency: 4,
				maxRequestRetries: 3,
				async requestHandler({ page }) {
					await page.waitForSelector(adapter.listingSelector);
					const pageListings = await adapter.extractListings(page);
					listings.push(...pageListings);
				},
				failedRequestHandler({ request }) {
					console.warn(`Failed: ${request.url} (${request.errorMessages[0]})`);
				},
			},
			config,
		);
		await crawler.run(adapter.startUrls);
		return { listings, pages: crawler.stats.state.requestsFinished };
	}

	const crawler = new CheerioCrawler(
		{
			maxRequestsPerCrawl,
			maxConcurrency: 6,
			maxRequestRetries: 3,
			async requestHandler({ $, request, enqueueLinks, body }) {
				// Strategy B: whole-page HTML extraction (embedded JSON).
				if (adapter.extractHtml) {
					const pushUrls = (urls: string[]) => {
						void enqueueLinks({ urls, label: "internal" });
					};
					const pageListings = await adapter.extractHtml(
						body.toString(),
						request.url,
						pushUrls,
					);
					listings.push(...pageListings);
					return;
				}

				// Strategy A: DOM card extraction.
				if (adapter.parseListingCard && adapter.listingSelector) {
					$(adapter.listingSelector).each((_, el) => {
						const listing = adapter.parseListingCard?.($ as never, el as never);
						if (listing) listings.push(listing);
					});
					if (adapter.nextPageSelector) {
						await enqueueLinks({ selector: adapter.nextPageSelector });
					}
				}
			},
			failedRequestHandler({ request }) {
				console.warn(`Failed: ${request.url} (${request.errorMessages[0]})`);
			},
		},
		config,
	);
	await crawler.run(adapter.startUrls);
	return { listings, pages: crawler.stats.state.requestsFinished };
}
