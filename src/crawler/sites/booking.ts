import type { Page, Response } from "playwright";

import { launchBrowser } from "../browser.ts";
import { REGIONS, type Region } from "../regions.ts";
import type { CustomLaunchAdapter, Listing } from "../types.ts";

/**
 * Booking.com short-term rental search results for every covered voivodeship
 * (Małopolska + Śląsk).
 * Booking's search page is DataDome-protected and serves a degraded, static
 * variant (no "load more" button, ~25 cards) to ordinary automated browsers.
 * A camoufox (Firefox anti-detect) session returns the real interactive view
 * (full property count + the "Załaduj więcej wyników" load-more button), so the
 * crawl launcher prefers camoufox and falls back to plain Playwright.
 *
 * One search session is capped by Booking itself at ~1000 clickable results,
 * while a voivodeship advertises far more properties. To get past the cap, each
 * region is sharded into per-city searches: every city runs its own
 * load-more drain with its own ~1000 budget, and duplicate properties collapse
 * in the DB upsert on `(source, externalId)`.
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
 * Per-city search shards, keyed by region id: the >1000 hotspots (Kraków,
 * Katowice conurbation), the spa/winter resorts, and the smaller towns so
 * regional supply isn't lost under the big-city rankings. One search session
 * is capped at ~1000 results by Booking, hence the shards.
 */
const BOOKING_CITIES_BY_REGION: Record<string, string[]> = {
	malopolskie: [
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
	],
	slaskie: [
		"Katowice",
		"Gliwice",
		"Zabrze",
		"Sosnowiec",
		"Bytom",
		"Częstochowa",
		"Bielsko-Biała",
		"Rybnik",
		"Tychy",
		"Chorzów",
		"Jaworzno",
		"Jastrzębie-Zdrój",
		"Szczyrk",
		"Wisła",
		"Ustroń",
		"Żywiec",
		"Tarnowskie Góry",
	],
};

/** City shards for a region; a newly added region must declare its own list. */
function citiesFor(region: Region): string[] {
	return BOOKING_CITIES_BY_REGION[region.id] ?? [];
}

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

/** One property card as rendered by Booking's search results. */
interface BookingCard {
	externalId: string;
	href: string;
	title: string | null;
	price: number | null;
	rating: number | null;
}

/**
 * Read the property cards currently in the DOM. The result list virtualizes,
 * so callers re-run this after every load-more round instead of trusting a
 * one-time snapshot.
 */
async function readCards(page: Page): Promise<BookingCard[]> {
	return page.evaluate(() => {
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
			let price: number | null = null;
			if (priceMatch) {
				const n = Number(priceMatch[1].replace(/\s/g, "").replace(",", "."));
				// Pinned window = exactly 7 nights; cards show the TOTAL for
				// the stay, so normalize to nightly (Airbnb-comparable).
				if (Number.isFinite(n) && n > 0) {
					price = Math.round((n / 7) * 100) / 100;
				}
			}
			const ratingEl = card.querySelector<HTMLElement>(
				'[data-testid="review-score"]',
			);
			const ratingMatch = (ratingEl?.innerText ?? "").match(/([\d,]+)/);
			const href = link?.href ?? "";
			// Keep the legacy key format (`pl/<slug>`): rows already in the DB
			// use it, so the coalesce-upsert enriches them in place instead of
			// inserting near-duplicates under a new key.
			const externalId = href.split("/hotel/")[1]?.split(".")[0] ?? href;
			return {
				externalId,
				href,
				title,
				price,
				rating: ratingMatch ? Number(ratingMatch[1].replace(",", ".")) : null,
			};
		});
	});
}

/**
 * Map rendered cards to listings, joining Booking's Apollo-cache geo facts by
 * property slug (the externalId carries a `pl/` prefix; strip it for the
 * lookup). `seen` de-duplicates across load-more rounds and city shards, and
 * `fallbackUrl` is the URL used by a card without an anchor.
 */
function listingsFromCards(
	cards: BookingCard[],
	geo: Map<string, GeoFacts>,
	seen: Set<string>,
	fallbackUrl: string,
): Listing[] {
	const listings: Listing[] = [];
	for (const card of cards) {
		if (!card.externalId || seen.has(card.externalId)) continue;
		seen.add(card.externalId);
		const facts = geo.get(card.externalId.replace(/^pl\//, ""));
		listings.push({
			source: "booking",
			externalId: card.externalId,
			url: card.href || fallbackUrl,
			title: card.title ?? "Booking listing",
			price: card.price,
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
			offerType: "short_term_rental",
			pricePeriod: "night",
			rating: card.rating ?? facts?.rating ?? null,
			reviewsCount: facts?.reviewsCount ?? null,
		});
	}
	return listings;
}

/**
 * Region-wide search for one covered voivodeship. Used as the DELTA PROBE:
 * its first batch is the market fingerprint — when every card on it is
 * already stored, that region is unchanged and its per-city drains are
 * skipped entirely.
 */
function regionSearchUrl(region: Region): string {
	const { checkin, checkout } = stayDates();
	return (
		"https://www.booking.com/searchresults.pl.html?" +
		new URLSearchParams({
			ss: region.province,
			ssne: region.province,
			ssne_untouched: region.province,
			dest_id: region.bookingDestId,
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
	name: "Booking - Małopolska + Śląsk short-term rentals",
	kind: "playwright",
	launchBrowser: () => launchBrowser(),
	// crawler.ts goto()s the FIRST start URL and hands that loaded page to
	// extractListings; every further region is navigated inside the adapter
	// (a custom-launch adapter drives its own browser and its own paging).
	startUrls: REGIONS.map(regionSearchUrl),
	maxRequestsPerCrawl: 1,
	listingSelector: '[data-testid="property-card"]',

	async extractListings(
		page: Page,
		opts?: { firstPageOnly?: boolean },
	): Promise<Listing[]> {
		const firstPageOnly = opts?.firstPageOnly === true;
		const all: Listing[] = [];

		for (const [index, region] of REGIONS.entries()) {
			// The crawler already navigated to startUrls[0]; later regions need
			// their own navigation.
			if (index > 0) {
				await page.goto(regionSearchUrl(region), {
					waitUntil: "domcontentloaded",
					timeout: 60000,
				});
				await page
					.waitForSelector('[data-testid="property-card"]', { timeout: 30000 })
					.catch(() => {
						// DataDome interstitial or empty market: probe what rendered.
					});
			}

			// ---- Delta probe: first batch of this region's search --------
			// crawler.ts already navigated here and waited for cards.
			const regionSeen = new Set<string>();
			const regionGeo = new Map<string, GeoFacts>();
			await harvestEmbeddedCache(page, regionGeo);
			const regionBatch = listingsFromCards(
				await readCards(page),
				regionGeo,
				regionSeen,
				"https://www.booking.com",
			);

			// When the ENTIRE first batch is already stored, this region is
			// unchanged: keep the batch (the DB upsert refreshes prices and ratings
			// for those rows) and skip its per-city drains — one browser session
			// instead of the whole city list, which is what used to poke the DataDome.
			const known = await knownBookingIds();
			if (
				known &&
				regionBatch.length > 0 &&
				regionBatch.every((l) => known.has(l.externalId))
			) {
				console.log(
					`booking: delta skip ${region.label} — first batch of ` +
						`${regionBatch.length} all known; skipping ${citiesFor(region).length} city drains`,
				);
				all.push(...regionBatch);
				continue;
			}
			const newOnFirstBatch = known
				? regionBatch.filter((l) => !known.has(l.externalId)).length
				: regionBatch.length;
			console.log(
				`booking: delta changed ${region.label} — ${newOnFirstBatch} new on ` +
					`first batch; draining ${citiesFor(region).length} city shards`,
			);

			all.push(...regionBatch);
			for (const city of citiesFor(region)) {
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
		all.push(...listingsFromCards(await readCards(page), geo, seen, url));
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
