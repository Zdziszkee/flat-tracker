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
	"https://www.booking.com/searchresults.pl.html?ss=ma%C5%82opolskie&ssne=ma%C5%82opolskie&ssne_untouched=ma%C5%82opolskie&efdco=1&label=gog235jc-10CAYotgFCC21hbG9wb2xza2llSB5YA2i2AYgBAZgBM7gBGcgBD9gBA-gBAfgBAYgCAagCAbgC6oW31AbAAgHSAiRiYzE5ZjQwZS0yYmYxLTRmYTYtOGFiNS1lNGZkOTIwZTZiMjDYAgHgAgE&aid=356980&lang=pl&sb=1&src_elem=sb&src=region&dest_id=1307&dest_type=region&group_adults=2&no_rooms=1&group_children=0&sb_lp=1&checkin=2026-09-01&checkout=2026-09-08";

// Booking strips the `offset` URL parameter and renders no page buttons:
// the search page appends more results when the "Załaduj więcej wyników"
// (load more results) button is clicked, up to a ~1000-property cap.
const MAX_LOAD_MORE_CLICKS = 40;

export const bookingAdapter: PlaywrightAdapter = {
	id: "booking",
	name: "Booking - Małopolska short-term rentals",
	kind: "playwright",
	startUrls: [SEARCH_URL],
	maxRequestsPerCrawl: 1,
	listingSelector: '[data-testid="property-card"]',

	async extractListings(page: Page): Promise<Listing[]> {
		const seen = new Set<string>();
		const all: Listing[] = [];

		const collect = async () => {
			const cards = await page.evaluate(() => {
				const els = Array.from(
					document.querySelectorAll<HTMLElement>(
						'[data-testid="property-card"]',
					),
				);
				return els.map((card) => {
					const title =
						card.querySelector<HTMLElement>('[data-testid="title"]')
							?.innerText ?? null;
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
						offerType: "short_term_rental" as const,
						pricePeriod: "night" as const,
						rating: ratingMatch
							? Number(ratingMatch[1].replace(",", "."))
							: null,
						reviewsCount: null,
					};
				});
			});
			for (const l of cards) {
				if (!seen.has(l.externalId)) {
					seen.add(l.externalId);
					all.push(l);
				}
			}
		};

		for (let i = 0; i <= MAX_LOAD_MORE_CLICKS; i++) {
			const before = seen.size;
			await collect();
			// A click that yields no new unique properties means the button is
			// gone or Booking ignored it: end of the result list.
			if (i > 0 && seen.size === before) break;
			if (i < MAX_LOAD_MORE_CLICKS) console.log(`booking: ${seen.size} unique`);

			const clicked = await page
				.evaluate(() => {
					const btn = Array.from(
						document.querySelectorAll<HTMLButtonElement>("button"),
					).find((b) => /załaduj więcej/i.test(b.textContent ?? ""));
					if (!btn || btn.disabled) return false;
					btn.scrollIntoView({ block: "center" });
					btn.click();
					return true;
				})
				.catch(() => false);
			if (!clicked) break;

			// Wait for the appended batch of cards to render.
			await page
				.waitForFunction(
					(prev) =>
						document.querySelectorAll('[data-testid="property-card"]').length >
						prev,
					seen.size,
					{ timeout: 10000 },
				)
				.catch(() => {});
			await page.waitForTimeout(800);
		}

		return all;
	},
};
