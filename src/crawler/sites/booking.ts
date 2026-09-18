import type { Page, Response } from "playwright";

import { launchBrowser } from "../browser.ts";
import type { CustomLaunchAdapter, Listing } from "../types.ts";

/**
 * Booking.com short-term rental search results for Małopolska.
 * Booking's search page is DataDome-protected and serves a degraded, static
 * variant (no "load more" button, ~25 cards) to ordinary automated browsers.
 * A camoufox (Firefox anti-detect) session returns the real interactive view
 * (full property count + the "Załaduj więcej wyników" load-more button), so the
 * crawl launcher prefers camoufox and falls back to plain Playwright.
 *
 * One search session is capped by Booking itself at ~1000 clickable results,
 * while the małopolskie region advertises far more properties. To get past
 * the cap, the crawl shards the region into per-city searches: every city
 * runs its own load-more drain with its own ~1000 budget, and duplicate
 * properties collapse in the DB upsert on `(source, externalId)`.
 *
 * Coordinates are not on the cards (`data-coords` was removed from Booking's
 * markup). They live instead in the page's Apollo cache: the big embedded
 * `application/json` script carries every result's
 * `basicPropertyData.location` (lat/lng/address/city), and each load-more
 * click fetches another such JSON batch. We harvest those payloads during the
 * drain and join them onto the cards by URL slug (`basicPropertyData.pageName`
 * === `/hotel/pl/<slug>`). Measured coverage: 98% of drained properties.
 *
 * NOTE: prices only render when `checkin`/`checkout` are present, so each
 * start URL pins a rolling 7-night window starting a week from now.
 */

/** Rolling 7-night stay window (prices require checkin/checkout). */
function stayDates(): { checkin: string; checkout: string } {
	const day = 24 * 3600 * 1000;
	const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
	return {
		checkin: iso(Date.now() + 7 * day),
		checkout: iso(Date.now() + 14 * day),
	};
}

/**
 * Per-city search shards covering Małopolska's short-term rental markets:
 * the two >1000 hotspots (Kraków, Zakopane area), the spa/winter resorts,
 * and the smaller towns so regional supply isn't lost under the big-city
 * rankings.
 */
const BOOKING_CITIES = [
	"Kraków",
	"Zakopane",
	"Białka Tatrzańska",
	"Wieliczka",
	"Krynica-Zdrój",
	"Szczawnica",
	"Rabka-Zdrój",
	"Nowy Targ",
	"Oświęcim",
	"Tarnów",
	"Nowy Sącz",
	"Wadowice",
	"Myślenice",
	"Olkusz",
];

function citySearchUrl(city: string): string {
	const { checkin, checkout } = stayDates();
	return (
		"https://www.booking.com/searchresults.pl.html?" +
		new URLSearchParams({
			ss: city,
			lang: "pl",
			sb: "1",
			src_elem: "sb",
			src: "city",
			group_adults: "2",
			no_rooms: "1",
			group_children: "0",
			checkin,
			checkout,
		}).toString()
	);
}

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
			els
				.map((el) => el.textContent ?? "")
				.filter((t) => t.includes('"latitude"')),
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

/**
 * Region-wide search (whole małopolskie voivodeship). Used as the DELTA
 * PROBE: its first batch is the market fingerprint — when every card on
 * it is already stored, the whole region is unchanged and the per-city
 * drains are skipped entirely.
 */
function regionSearchUrl(): string {
	const { checkin, checkout } = stayDates();
	return (
		"https://www.booking.com/searchresults.pl.html?" +
		new URLSearchParams({
			ss: "małopolskie",
			ssne: "małopolskie",
			ssne_untouched: "małopolskie",
			dest_id: "1307",
			dest_type: "region",
			group_adults: "2",
			no_rooms: "1",
			group_children: "0",
			checkin,
			checkout,
			lang: "pl",
			sb: "1",
			src: "region",
			src_elem: "sb",
		}).toString()
	);
}

/**
 * Delta mode: skip the (expensive, DataDome-provoking) per-city drains
 * when the region search's first batch shows nothing new. Disable with
 * BOOKING_DELTA=0.
 */
const BOOKING_DELTA = (process.env.BOOKING_DELTA ?? "1") !== "0";

/** Every booking externalId already stored — the delta fingerprint. */
async function knownBookingIds(): Promise<Set<string> | null> {
	if (!BOOKING_DELTA) return null;
	try {
		const { db } = await import("../../db/index.ts");
		const { listings } = await import("../../db/schema.ts");
		const { eq } = await import("drizzle-orm");
		const rows = await db
			.select({ externalId: listings.externalId })
			.from(listings)
			.where(eq(listings.source, "booking"));
		return new Set(rows.map((r) => r.externalId));
	} catch {
		return null;
	}
}

/**
 * DataDome-protected: needs the camoufox anti-detect launcher, which Crawlee
 * cannot accept — exposed as a capability the crawler detects and calls.
 */
export const bookingAdapter: CustomLaunchAdapter = {
	id: "booking",
	name: "Booking - Małopolska short-term rentals",
	kind: "playwright",
	launchBrowser: () => launchBrowser(),
	// crawler.ts goto()s this once and hands the loaded page to
	// extractListings — the region probe reuses that navigation.
	startUrls: [regionSearchUrl()],
	maxRequestsPerCrawl: 1,
	listingSelector: '[data-testid="property-card"]',

	async extractListings(
		page: Page,
		opts?: { firstPageOnly?: boolean },
	): Promise<Listing[]> {
		const firstPageOnly = opts?.firstPageOnly === true;

		// ---- Delta probe: first batch of the region-wide search --------
		// crawler.ts already navigated here and waited for cards.
		const regionSeen = new Set<string>();
		const regionGeo = new Map<string, GeoFacts>();
		await harvestEmbeddedCache(page, regionGeo);
		const regionBatch: Listing[] = [];
		const cards = await page.evaluate(() => {
			const els = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="property-card"]'),
			);
			return els.map((card) => {
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
						// Pinned window = exactly 7 nights; cards show the TOTAL
						// for the stay — normalize to nightly (Airbnb-comparable).
						return Number.isFinite(n) && n > 0
							? Math.round((n / 7) * 100) / 100
							: null;
					})();
				const ratingEl = card.querySelector<HTMLElement>(
					'[data-testid="review-score"]',
				);
				const ratingMatch = (ratingEl?.innerText ?? "").match(/([\d,]+)/);
				const href = link?.href ?? "";
				const externalId = href.split("/hotel/")[1]?.split(".")[0] ?? href;
				return { externalId, href, title, price, ratingMatch };
			});
		});
		for (const c of cards) {
			if (!c.externalId || regionSeen.has(c.externalId)) continue;
			regionSeen.add(c.externalId);
			const facts = regionGeo.get(c.externalId.replace(/^pl\//, ""));
			regionBatch.push({
				source: "booking",
				externalId: c.externalId,
				url: c.href || "https://www.booking.com",
				title: c.title ?? "Booking listing",
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
				listedAt: null,
				scrapedAt: new Date().toISOString(),
				offerType: "short_term_rental" as const,
				pricePeriod: "night" as const,
				rating: c.ratingMatch
					? Number(c.ratingMatch[1].replace(",", "."))
					: (facts?.rating ?? null),
				reviewsCount: facts?.reviewsCount ?? null,
			});
		}

		// When the ENTIRE first batch is already stored, the region is
		// unchanged: return the batch (the DB upsert refreshes prices and
		// ratings for those rows) and skip all per-city drains — one browser
		// session instead of 14, which is what used to poke the DataDome.
		const known = await knownBookingIds();
		if (
			known &&
			regionBatch.length > 0 &&
			regionBatch.every((l) => known.has(l.externalId))
		) {
			console.log(
				`booking: delta skip — region first batch of ` +
					`${regionBatch.length} all known; skipping ${BOOKING_CITIES.length} city drains`,
			);
			return regionBatch;
		}
		const newOnFirstBatch = known
			? regionBatch.filter((l) => !known.has(l.externalId)).length
			: regionBatch.length;
		console.log(
			`booking: delta changed — ${newOnFirstBatch} new on region first ` +
				`batch; draining ${BOOKING_CITIES.length} city shards`,
		);

		const all: Listing[] = [...regionBatch];
		for (const city of BOOKING_CITIES) {
			const shard = await drainCity(page, citySearchUrl(city), {
				firstPageOnly,
			});
			all.push(...shard);
			console.log(
				`booking [${city}]: ${shard.length} properties ` +
					`(${all.length} total across shards)`,
			);
			if (!firstPageOnly) {
				// Pause between city sessions so the DataDome sees human pacing.
				await page.waitForTimeout(4000);
			}
		}
		return all;
	},
};

/**
 * Drain one city search session. `seen`/`geo` are per-session on purpose:
 * each search gets its own load-more budget from Booking, and duplicates
 * across cities collapse later in the DB upsert.
 */
async function drainCity(
	page: Page,
	url: string,
	opts: { firstPageOnly: boolean },
): Promise<Listing[]> {
	await page.goto(url, {
		waitUntil: "domcontentloaded",
		timeout: 60000,
	});
	await page
		.waitForSelector('[data-testid="property-card"]', { timeout: 30000 })
		.catch(() => {
			// DataDome interstitial or empty market; collect() below returns
			// whatever rendered.
		});

	const seen = new Set<string>();
	const all: Listing[] = [];
	const geo = new Map<string, GeoFacts>();

	await harvestEmbeddedCache(page, geo);

	// Load-more batches arrive as JSON XHRs; capture them as they fly.
	// The listener is scoped to this session: remove it before returning so
	// consecutive city drains don't stack stale handlers on the same page.
	let onResponse: ((res: Response) => void) | null = null;
	if (!opts.firstPageOnly) {
		onResponse = (res: Response) => {
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
		};
		page.on("response", onResponse);
	}

	const collect = async () => {
		const cards = await page.evaluate(() => {
			const els = Array.from(
				document.querySelectorAll<HTMLElement>('[data-testid="property-card"]'),
			);
			return els.map((card) => {
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
						// Pinned window = exactly 7 nights; cards show the TOTAL
						// for the stay — normalize to nightly (Airbnb-comparable).
						return Number.isFinite(n) && n > 0
							? Math.round((n / 7) * 100) / 100
							: null;
					})();
				const ratingEl = card.querySelector<HTMLElement>(
					'[data-testid="review-score"]',
				);
				const ratingMatch = (ratingEl?.innerText ?? "").match(/([\d,]+)/);
				const href = link?.href ?? "";
				// Keep the legacy key format (`pl/<slug>`): rows already in
				// the DB use it, so the coalesce-upsert enriches them in
				// place instead of inserting near-duplicates under a new key.
				const externalId = href.split("/hotel/")[1]?.split(".")[0] ?? href;

				return {
					source: "booking",
					externalId,
					url: href || location.href,
					title: title ?? "Booking listing",
					price,
					ratingFromCard: ratingMatch
						? Number(ratingMatch[1].replace(",", "."))
						: null,
					listedAt: null as string | null,
				};
			});
		});
		for (const c of cards) {
			if (!c.externalId || seen.has(c.externalId)) continue;
			seen.add(c.externalId);
			// Join Apollo-cache facts by slug (the externalId carries a
			// `pl/` prefix; strip it for the lookup). Rating may appear only
			// on the card or only in the cache: prefer whichever exists.
			const facts = geo.get(c.externalId.replace(/^pl\//, ""));
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
	if (opts.firstPageOnly) return all;

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
	try {
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
			if (round % 10 === 0) {
				console.log(`booking: ${seen.size} unique (${geo.size} with coords)`);
			}

			if (seen.size >= MAX_PROPERTIES_CAP) break;
		}
	} finally {
		if (onResponse) page.off("response", onResponse);
	}

	console.log(
		`booking: done, ${seen.size} unique properties, ` +
			`${all.filter((l) => l.lat !== null).length} with coordinates`,
	);
	return all;
}
