import {
	CheerioCrawler,
	Configuration,
	log,
	MemoryStorage,
	PlaywrightCrawler,
} from "crawlee";

import type { CustomLaunchAdapter, Listing, SiteAdapter } from "./types.ts";

// Keep crawler logs compact: warnings/errors only. The per-page progress
// lines come from the adapters themselves via console.log, and failures are
// surfaced through failedRequestHandler / console.warn.
log.setLevel(log.LEVELS.WARNING);

export interface CrawlResult {
	listings: Listing[];
	pages: number;
}

/**
 * Run a crawl for a site adapter. Uses a real browser for JS-rendered
 * sites and plain HTTP + Cheerio for static ones, with the same output.
 *
 * Adapters carrying a `launchBrowser` capability (WAF/anti-detect sources
 * such as Booking behind DataDome and licytacje.komornik.pl) launch their
 * own camoufox browser instead of letting Crawlee start chromium; the
 * resulting page is handed to `extractListings`.
 */
export async function crawlSite(adapter: SiteAdapter): Promise<CrawlResult> {
	const listings: Listing[] = [];
	// In-memory only: no storage/ dirs in the repo, and concurrent crawls
	// (dev server + hourly task) must not race over queue files on disk.
	const config = new Configuration({
		storageClient: new MemoryStorage({ persistStorage: false }),
	});

	const firstPageOnly =
		adapter.firstPageOnly === true && !adapter.alwaysFullCrawl;
	const maxRequestsPerCrawl = firstPageOnly
		? 1
		: (adapter.maxRequestsPerCrawl ?? 100);

	if (adapter.kind === "playwright") {
		// Custom-launch adapters (anti-detect browser) drive their own browser;
		// the adapter's extractListings() drives pagination/load-more itself.
		if (typeof (adapter as CustomLaunchAdapter).launchBrowser === "function") {
			const custom = adapter as CustomLaunchAdapter;
			const browser = await custom.launchBrowser();
			try {
				// viewport:null keeps camoufox's injected fingerprint window size
				// instead of overriding it (Booking fingerprints viewports).
				const context = await browser.newContext({
					viewport: null,
					locale: "pl-PL",
				});
				const page = await context.newPage();
				await page.goto(adapter.startUrls[0], {
					waitUntil: "domcontentloaded",
					timeout: 60000,
				});
				await page.waitForSelector(adapter.listingSelector, {
					timeout: 30000,
				});
				const pageListings = await adapter.extractListings(page, {
					firstPageOnly,
				});
				listings.push(...pageListings);
				await page.close();
			} finally {
				await browser.close();
			}
			return { listings, pages: 1 };
		}

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
			// Some portals (nieruchomosci-online) mislabel their HTML as
			// text/plain; accept it so the Cheerio parser still runs.
			additionalMimeTypes: ["text/plain"],
			// Otodom/OLX return 403 when we burst; retry those with backoff
			// instead of giving up immediately.
			retryOnBlocked: true,
			async requestHandler({ $, request, enqueueLinks, addRequests, body }) {
				// Polite pacing: portals throttle bursty crawlers (403s).
				await new Promise((r) => setTimeout(r, 800));
				// Strategy B: whole-page extraction (embedded JSON or raw API).
				if (adapter.extractHtml) {
					// Use the request manager directly instead of `enqueueLinks`:
					// Crawlee swaps `enqueueLinks` for a no-op stub on non-HTML
					// responses (JSON APIs), silently dropping pagination.
					// `addRequests` works for any content type.
					const pushUrls = (urls: string[]) =>
						addRequests(urls).then(() => undefined);
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
