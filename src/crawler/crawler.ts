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
	// In-memory only: no storage/ dirs in the repo, and concurrent crawls
	// (dev server + hourly task) must not race over queue files on disk.
	const config = new Configuration({
		storageClient: new MemoryStorage({ persistStorage: false }),
	});

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
			maxConcurrency: 3,
			maxRequestRetries: 5,
			// Otodom/OLX return 403 when we burst; retry those with backoff
			// instead of giving up immediately.
			retryOnBlocked: true,
			async requestHandler({ $, request, enqueueLinks, body }) {
				// Polite pacing: portals throttle bursty crawlers.
				await new Promise((r) => setTimeout(r, 350));
				// Strategy B: whole-page HTML extraction (embedded JSON).
				if (adapter.extractHtml) {
					// Return the promise so the handler awaits queue adds; a
					// fire-and-forget enqueue can race the crawler's empty-queue
					// check and end the run before the next page is enqueued.
					const pushUrls = (urls: string[]) =>
						enqueueLinks({ urls, label: "internal" }).then(() => undefined);
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
