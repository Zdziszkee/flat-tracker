import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";

/**
 * Demo adapter for a static site (books.toscrape.com).
 * All data is in the HTML source, so plain HTTP + Cheerio is enough.
 */
export const booksAdapter: CheerioAdapter = {
	id: "books",
	name: "Books to Scrape (static HTML)",
	kind: "cheerio",
	startUrls: ["https://books.toscrape.com/"],
	maxRequestsPerCrawl: 5,
	nextPageSelector: ".pager .next a",
	listingSelector: "article.product_pod",

	parseListingCard($: CheerioSelection, el: unknown): Listing | null {
		const $el = $(el as never);
		const title = $el.find("h3 a").attr("title")?.trim() ?? null;
		if (!title) return null;

		const priceText = $el.find(".price_color").text().trim();
		const priceMatch = priceText.match(/[\d.,]+/);
		const price = priceMatch
			? Number.parseFloat(priceMatch[0].replace(",", "."))
			: null;
		const href = $el.find("h3 a").attr("href");
		const url = href
			? new URL(href, "https://books.toscrape.com/").href
			: "https://books.toscrape.com/";

		return {
			source: this.id,
			externalId: url,
			url,
			title,
			price,
			pricePerM2: null,
			areaM2: null,
			rooms: null,
			floor: null,
			district: null,
			address: null,
			description: null,
			heatingType: null,
			propertyType: null,
			features: null,
			lat: null,
			lng: null,
			listedAt: null,
			scrapedAt: new Date().toISOString(),
		};
	},
};
