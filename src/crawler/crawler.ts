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
	/**
	 * HTTP status when the portal actively refused us mid-run (429 rate limit,
	 * or repeated 403 WAF blocks) and the crawl was stopped early. Undefined
	 * when the run completed normally.
	 */
	blocked?: number;
}

/**
 * Detect "the portal is refusing us" from Crawlee error messages. Crawlee's
 * session rotation re-queues blocked requests *without counting them as
 * retries*, which churns forever against a hard block (a 429 wall), so we
 * detect the block and stop the run instead — "try later" beats hammering.
 */
export function blockStatus(
	...messages: (string | undefined | null)[]
): number | null {
	const text = messages.filter(Boolean).join("\n");
	// Crawlee shapes: "Blocked by status code 429." (session-error path) and
	// "Request blocked - received 429 status code." (_throwOnBlockedRequest).
	for (const m of text.matchAll(
		/(?:status(?:\s+code)?|received|HTTP|code)\s*(\d{3})|(\d{3})\s*status/gi,
	)) {
		const status = Number(m[1] ?? m[2]);
		if (status === 429 || status === 403) return status;
	}
	return null;
}

interface StopLike {
	stop?: () => void;
	autoscaledPool?: { abort?: () => void };
}

function stopCrawler(crawler: StopLike): void {
	try {
		if (typeof crawler.stop === "function") crawler.stop();
		else crawler.autoscaledPool?.abort?.();
	} catch {
		// stopping is best-effort; the request loop exits either way
	}
}

/**
 * Per-run block policy: a 429 (explicit rate limit) stops the run at once and
 * is never retried; 403s are the documented otodom/olx burst response and
 * keep their bounded retries, but once five blocked attempts pile up (a
 * persistent WAF block) the run stops too.
 */
function makeBlockTracker() {
	let blocked: number | null = null;
	let blocked403 = 0;
	return {
		note(
			status: number | null,
			request: { noRetry?: boolean },
			stop: () => void,
		) {
			if (!status) return;
			if (status === 429) {
				// never retry a rate limit — "try later", not "try again now"
				request.noRetry = true;
				blocked = 429;
				stop();
			} else if (blocked !== 429 && ++blocked403 >= 5) {
				blocked = 403;
				stop();
			}
		},
		get: () => blocked ?? undefined,
	};
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
	const block = makeBlockTracker();
	// In-memory only: no storage/ dirs in the repo, and concurrent crawls
	// (dev server + hourly task) must not race over queue files on disk.
	const config = new Configuration({
		storageClient: new MemoryStorage({ persistStorage: false }),
	});

	const firstPageOnly =
		adapter.firstPageOnly === true && !adapter.alwaysFullCrawl;
	const maxRequestsPerCrawl = firstPageOnly
		? (adapter.firstPageOnlyRequests ?? 1)
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
				maxRequestRetries: 2,
				async requestHandler({ page }) {
					await page.waitForSelector(adapter.listingSelector);
					const pageListings = await adapter.extractListings(page);
					listings.push(...pageListings);
				},
				async errorHandler({ request, crawler }, error) {
					block.note(
						blockStatus(error?.message, ...(request.errorMessages ?? [])),
						request,
						() => stopCrawler(crawler as StopLike),
					);
				},
				async failedRequestHandler({ request, crawler }, error) {
					console.warn(`Failed: ${request.url} (${request.errorMessages[0]})`);
					block.note(
						blockStatus(error?.message, ...(request.errorMessages ?? [])),
						request,
						() => stopCrawler(crawler as StopLike),
					);
				},
			},
			config,
		);
		await crawler.run(adapter.startUrls);
		return {
			listings,
			pages: crawler.stats.state.requestsFinished,
			blocked: block.get(),
		};
	}

	const crawler = new CheerioCrawler(
		{
			maxRequestsPerCrawl,
			maxConcurrency: 3,
			maxRequestRetries: 2,
			// Some portals (nieruchomosci-online) mislabel their HTML as
			// text/plain; accept it so the Cheerio parser still runs.
			additionalMimeTypes: ["text/plain"],
			// Blocks are handled by `block` above: bounded retries, never the
			// session-rotation loop that re-queues a blocked request forever.
			retryOnBlocked: false,
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
						$ as never,
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
			async errorHandler({ request, crawler }, error) {
				block.note(
					blockStatus(error?.message, ...(request.errorMessages ?? [])),
					request,
					() => stopCrawler(crawler as StopLike),
				);
			},
			async failedRequestHandler({ request, crawler }, error) {
				console.warn(`Failed: ${request.url} (${request.errorMessages[0]})`);
				block.note(
					blockStatus(error?.message, ...(request.errorMessages ?? [])),
					request,
					() => stopCrawler(crawler as StopLike),
				);
			},
		},
		config,
	);
	await crawler.run(adapter.startUrls);
	return {
		listings,
		pages: crawler.stats.state.requestsFinished,
		blocked: block.get(),
	};
}
