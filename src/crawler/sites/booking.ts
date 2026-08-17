import type { Page } from "playwright";

import type { Listing, PlaywrightAdapter } from "../types.ts";

/**
 * Booking.com short-term rental search results for Małopolska (Kraków as the
 * destination anchor). Booking's search page is DataDome-protected and needs
 * a real browser; the card DOM is parsed in-page.
 *
 * NOTE: prices only render when `checkin`/`checkout` are present, so the
 * start URL pins a rolling 7-night window. This adapter is intentionally not
 * registered in the shared `adapters` list until it has been verified against
 * a live session — run it manually via `npm run crawl:booking`.
 */

const SEARCH_URL =
	"https://www.booking.com/searchresults.pl.html?ss=Krak%C3%B3w&checkin=2026-08-20&checkout=2026-08-27&group_adults=2&no_rooms=1&group_children=0";

export const bookingAdapter: PlaywrightAdapter = {
	id: "booking",
	name: "Booking - Małopolska short-term rentals",
	kind: "playwright",
	startUrls: [SEARCH_URL],
	maxRequestsPerCrawl: 5,
	listingSelector: '[data-testid="property-card"]',

	async extractListings(page: Page): Promise<Listing[]> {
		return page.evaluate(() => {
			const cards = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="property-card"]'),
			);
			return cards.map((card) => {
				const title =
					card.querySelector<HTMLElement>('[data-testid="title"]')?.innerText ??
					null;
				const link = card.querySelector<HTMLAnchorElement>(
					'a[data-testid="title-link"], a[href*="booking.com/hotel"]',
				);
				const priceEl = card.querySelector<HTMLElement>(
					'[data-testid="price-and-discounted-price"]',
				);
				const priceText = priceEl?.innerText ?? card.innerText;
				const priceMatch = priceText.match(/([\d\s.,]+)\s*zł/i);
				const price =
					priceMatch &&
					(() => {
						const n = Number(
							priceMatch[1].replace(/\s/g, "").replace(",", "."),
						);
						return Number.isFinite(n) && n > 0 ? n : null;
					})();
				const ratingEl = card.querySelector<HTMLElement>(
					'[data-testid="review-score"]',
				);
				const ratingMatch = (ratingEl?.innerText ?? "").match(/([\d,]+)/);
				const coordsEl = card.querySelector<HTMLElement>("[data-coords]");
				const coords = coordsEl?.getAttribute("data-coords") ?? null;
				const [lat, lng] = coords
					? coords.split(",").map(Number)
					: [null, null];
				const href = link?.href ?? "";
				const externalId = href.split("/hotel/")[1]?.split(".")[0] ?? href;

				return {
					source: "booking",
					externalId,
					url: href || location.href,
					title: title ?? "Booking listing",
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
					lat: lat && lng ? lat : null,
					lng: lat && lng ? lng : null,
					listedAt: null,
					scrapedAt: new Date().toISOString(),
					offerType: "short_term_rental",
					pricePeriod: "night",
					rating: ratingMatch ? Number(ratingMatch[1].replace(",", ".")) : null,
					reviewsCount: null,
				};
			});
		});
	},
};
