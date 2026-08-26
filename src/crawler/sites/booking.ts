import type { Page, Response } from "playwright";

import type { Listing, PlaywrightAdapter } from "../types.ts";

/**
 * Booking.com short-term rental search results for Małopolska (entire region).
 * Booking's search page is DataDome-protected and serves a degraded, static
 * variant (no "load more" button, ~25 cards) to ordinary automated browsers.
 * A camoufox (Firefox anti-detect) session returns the real interactive view
 * (full property count + the "Załaduj więcej wyników" load-more button), so the
 * crawl launcher prefers camoufox and falls back to plain Playwright.
 *
 * Coordinates are not on the cards (`data-coords` was removed from Booking's
 * markup). They live instead in the page's Apollo cache: the big embedded
 * `application/json` script carries every result's
 * `basicPropertyData.location` (lat/lng/address/city), and each load-more
 * click fetches another such JSON batch. We harvest those payloads during the
 * drain and join them onto the cards by URL slug (`basicPropertyData.pageName`
 * === `/hotel/pl/<slug>`). Measured coverage: 98% of drained properties.
 *
 * NOTE: prices only render when `checkin`/`checkout` are present, so the
 * start URL pins a rolling 7-night window.
 */

const SEARCH_URL =
	"https://www.booking.com/searchresults.pl.html?ss=ma%C5%82opolskie&ssne=ma%C5%82opolskie&ssne_untouched=ma%C5%82opolskie&efdco=1&label=gog235jc-10CAYotgFCC21hbG9wb2xza2llSB5YA2i2AYgBAZgBM7gBGcgBD9gBA-gBAfgBAYgCAagCAbgC6oW31AbAAgHSAiRiYzE5ZjQwZS0yYmYxLTRmYTYtOGFiNS1lNGZkOTIwZTZiMjDYAgHgAgE&aid=356980&lang=pl&sb=1&src_elem=sb&src=region&dest_id=1307&dest_type=region&group_adults=2&no_rooms=1&group_children=0&sb_lp=1&checkin=2026-09-01&checkout=2026-09-08&chal_t=1787675374022&force_referer=https%3A%2F%2Fwww.booking.com%2Fregion%2Fpl%2Fmalopolskie.pl.html";

// Booking strips the `offset` URL parameter and renders no page buttons:
// the search page appends more results when the "Załaduj więcej wyników"
// (load more results) button is clicked, up to a ~1000-property cap.
const MAX_LOAD_MORE_CLICKS = 40;
// Booking's own cap on scrollable/clickable search results.
const MAX_PROPERTIES_CAP = 1000;

/** Geo/review facts joined from Booking's Apollo cache by property slug. */
interface GeoFacts {
	lat: number;
	lng: number;
	address: string | null;
	city: string | null;
	rating: number | null;
	reviewsCount: number | null;
}

/**
 * Walk an arbitrary Apollo-cache JSON tree and merge every
 * `basicPropertyData` result into `geo`, keyed by URL slug.
 */
function harvestGeo(geo: Map<string, GeoFacts>, data: unknown): number {
	let found = 0;
	const walk = (node: unknown, depth: number): void => {
		if (depth > 16 || node === null || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child, depth + 1);
			return;
		}
		const rec = node as Record<string, unknown>;
		const bpd = rec.basicPropertyData as
			| {
					pageName?: string;
					location?: {
						latitude?: number;
						longitude?: number;
						address?: string;
						city?: string;
					};
					reviews?: { totalScore?: number; reviewsCount?: number };
			  }
			| undefined;
		if (
			bpd &&
			typeof bpd.pageName === "string" &&
			typeof bpd.location?.latitude === "number" &&
			typeof bpd.location.longitude === "number" &&
			!geo.has(bpd.pageName)
		) {
			const score = bpd.reviews?.totalScore;
			geo.set(bpd.pageName, {
				lat: bpd.location.latitude,
				lng: bpd.location.longitude,
				address: bpd.location.address ?? null,
				city: bpd.location.city ?? null,
				rating: typeof score === "number" ? score : null,
				reviewsCount: bpd.reviews?.reviewsCount ?? null,
			});
			found++;
		}
		for (const value of Object.values(rec)) walk(value, depth + 1);
	};
	walk(data, 0);
	return found;
}

/** Read the page's embedded Apollo-cache scripts (initial page-1 payload). */
async function harvestEmbeddedCache(
	page: Page,
	geo: Map<string, GeoFacts>,
): Promise<number> {
	const scripts = await page
		.$$eval('script[type="application/json"]', (els) =>
			els.map((el) => el.textContent ?? "").filter((t) => t.includes('"latitude"')),
		)
		.catch(() => [] as string[]);
	let found = 0;
	for (const text of scripts) {
		try {
			found += harvestGeo(geo, JSON.parse(text));
		} catch {
			// Truncated/odd script: skip.
		}
	}
	return found;
}

export const bookingAdapter: PlaywrightAdapter = {
	id: "booking",
	name: "Booking - Małopolska short-term rentals",
	kind: "playwright",
	startUrls: [SEARCH_URL],
	maxRequestsPerCrawl: 1,
	listingSelector: '[data-testid="property-card"]',

	async extractListings(
		page: Page,
		opts?: { firstPageOnly?: boolean },
	): Promise<Listing[]> {
		const firstPageOnly = opts?.firstPageOnly === true;
		const seen = new Set<string>();
		const all: Listing[] = [];
		const geo = new Map<string, GeoFacts>();

		await harvestEmbeddedCache(page, geo);

		// Load-more batches arrive as JSON XHRs; capture them as they fly.
		if (!firstPageOnly) {
			page.on("response", (res: Response) => {
				void res
					.text()
					.then((body) => {
						if (body.includes('"latitude"')) {
							try {
								harvestGeo(geo, JSON.parse(body));
							} catch {
								// HTML masquerading as JSON or a truncated chunk: skip.
							}
						}
					})
					.catch(() => {});
			});
		}

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
					const href = link?.href ?? "";
					const externalId =
						href.match(/\/hotel\/pl\/([^./?#]+)/)?.[1] ??
						href.split("/hotel/")[1]?.split(".")[0] ??
						href;

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
						ratingFromCard: ratingMatch
							? Number(ratingMatch[1].replace(",", "."))
							: null,
						listedAt: null,
					};
				});
			});
			for (const c of cards) {
				if (!c.externalId || seen.has(c.externalId)) continue;
				seen.add(c.externalId);
				// Join Apollo-cache facts by slug; fall back to whatever the card
				// itself rendered (rating may appear only on one of the two).
				const facts = geo.get(c.externalId);
				const rating = c.ratingFromCard ?? facts?.rating ?? null;
				all.push({
					source: "booking",
					externalId: c.externalId,
					url: c.url,
					title: c.title,
					price: c.price,
					pricePerM2: null,
					areaM2: null,
					rooms: null,
					floor: null,
					district: null,
					address:
						facts?.address && facts?.city
							? `${facts.address}, ${facts.city}`
							: (facts?.address ?? facts?.city ?? null),
					description: null,
					heatingType: null,
					propertyType: null,
					features: null,
					lat: facts?.lat ?? null,
					lng: facts?.lng ?? null,
					listedAt: c.listedAt,
					scrapedAt: new Date().toISOString(),
					offerType: "short_term_rental" as const,
					pricePeriod: "night" as const,
					rating,
					reviewsCount: facts?.reviewsCount ?? null,
				});
			}
		};

		await collect();
		if (firstPageOnly) return all;

		// Let the SPA finish hydrating: clicking too early leaves the
		// load-more pipeline inert for the rest of the session.
		await page.waitForTimeout(8000);

		/*
		 * Drain to Booking's ~1000-property cap. The result list virtualizes
		 * (the DOM only ever holds ~75 cards), so track unique hotel slugs
		 * across rounds instead of DOM counts. Each round: click the load-more
		 * button via a JS-dispatched click (a trusted Playwright click gets
		 * intercepted by sticky overlays), harvest cards, scroll to the bottom
		 * (scrolling alone grows the DOM past ~26 initial cards and surfaces
		 * the button again), and stop when uniques plateau without a button.
		 */
		let stableRounds = 0;
		for (
			let round = 0;
			round < MAX_LOAD_MORE_CLICKS * 5 && stableRounds < 12;
			round++
		) {
			const before = seen.size;

			const clicked = await page
				.evaluate(() => {
					const btn = Array.from(
						document.querySelectorAll<HTMLButtonElement>("button"),
					).find((b) =>
						/załaduj więcej wyników|load more results/i.test(
							b.textContent ?? "",
						),
					);
					if (!btn || btn.disabled) return false;
					btn.scrollIntoView({ block: "center" });
					btn.click();
					return true;
				})
				.catch(() => false);
			if (clicked) {
				// Wait for the appended batch of cards (and its JSON XHR) to land.
				await page.waitForTimeout(2500);
			}

			await collect();
			await page.evaluate(() =>
				window.scrollTo(0, document.documentElement.scrollHeight),
			);
			await page.waitForTimeout(1300);

			stableRounds = seen.size === before ? stableRounds + 1 : 0;
			if (round % 5 === 0) {
				console.log(
					`booking: ${seen.size} unique (${geo.size} with coordinates)`,
				);
			}

			if (seen.size >= MAX_PROPERTIES_CAP) break;
		}

		console.log(
			`booking: done, ${seen.size} unique properties, ` +
				`${all.filter((l) => l.lat !== null).length} with coordinates`,
		);
		return all;
	},
};
