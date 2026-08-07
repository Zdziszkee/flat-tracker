import type { Page } from "playwright";

import type { Listing, PlaywrightAdapter } from "../types.ts";

/**
 * Demo adapter for a JS-rendered site (quotes.toscrape.com/js).
 * Content is injected client-side, so it needs a real browser.
 */
export const quotesAdapter: PlaywrightAdapter = {
	id: "quotes",
	name: "Quotes to Scrape (JS-rendered)",
	kind: "playwright",
	startUrls: ["https://quotes.toscrape.com/js/"],
	maxRequestsPerCrawl: 5,
	listingSelector: ".quote",

	async extractListings(page: Page): Promise<Listing[]> {
		const quotes = await page.locator(".quote").evaluateAll((els: Element[]) =>
			els.map((el) => ({
				text: el.querySelector(".text")?.textContent?.trim() ?? "",
				author: el.querySelector(".author")?.textContent?.trim() ?? "",
			})),
		);

		return quotes.map((quote: { text: string; author: string }) => ({
			source: this.id,
			externalId: page.url(),
			url: page.url(),
			title: quote.text,
			price: null,
			pricePerM2: null,
			areaM2: null,
			rooms: null,
			floor: null,
			district: quote.author,
			lat: null,
			lng: null,
			listedAt: null,
			scrapedAt: new Date().toISOString(),
		}));
	},
};
