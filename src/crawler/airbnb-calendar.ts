import "dotenv/config";

import { eq, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { listings } from "#/db/schema";
import {
	foldMonthlyPrices,
	saveAvailabilityObservations,
} from "./availability.ts";
import { launchBrowser } from "./browser.ts";
import { foldOccupancy } from "./occupancy.ts";

/**
 * Airbnb availability-calendar importer, browser-first.
 *
 * Simulates a user: opens each listing page in a real browser, captures the
 * availability response the page itself requests, and reads stay totals for
 * the next 4 months (seasonality), 1/3/30-night lengths (duration discount)
 * and varied check-in weekdays (weekend premium).
 *
 * SCRAPING CADENCE: every day the task walks ALL active listings
 * (~17k x ~10 page loads) — the user accepted the rate-limit risk
 * explicitly. Ordering still prioritizes what matters first:
 * never-observed listings, then check-ins inside CHECKIN_SOON_DAYS
 * (prices get dynamic near arrival), then oldest-observed. A small
 * inter-listing delay (AIRBNB_CALENDAR_DELAY_MS, default 250) keeps the
 * run from bursting.
 */

const MONTHS = 4;
/** Listings with a check-in inside this window are re-observed first. */
const CHECKIN_SOON_DAYS = 14;
/** Politeness pause between listings (ms). */
const LISTING_DELAY_MS = Number(process.env.AIRBNB_CALENDAR_DELAY_MS ?? 250);

interface CalendarDay {
	calendarDate?: string;
	available?: boolean;
	minNights?: number;
	maxNights?: number;
}

interface CalendarResponse {
	data?: {
		merlin?: {
			pdpAvailabilityCalendar?: {
				calendarMonths?: Array<{ days?: CalendarDay[] }>;
			};
		};
	};
}

/** Last calendar-scrape failure (for the circuit-breaker log). */
let lastCalendarError = "";
let consecutiveFailures = 0;
/** Stop the run when this many listings fail in a row (rate-limited). */
const FAILURE_BREAK = 50;

function roomUrl(
	listingId: string,
	start: string,
	end: string,
	adults = 2,
): string {
	return `https://www.airbnb.pl/rooms/${listingId}?check_in=${start}&check_out=${end}&adults=${adults}`;
}

async function scrapeStayTotal(
	page: import("playwright").Page,
	listingId: string,
	start: string,
	end: string,
	adults = 2,
): Promise<number | null> {
	try {
		await page.goto(roomUrl(listingId, start, end, adults), {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
		await page
			.waitForSelector(
				'[data-testid="book-it-default"], [aria-label="Kalendarz"]',
				{
					timeout: 20_000,
				},
			)
			.catch(() => {});
		return await page.evaluate(() => {
			const text =
				document.querySelector<HTMLElement>('[data-testid="book-it-default"]')
					?.innerText ?? "";
			const amounts = [...text.matchAll(/([\d\s.,]+)\s*zł/g)]
				.map((m) => Number(m[1].replace(/\s/g, "").replace(",", ".")))
				.filter((n) => Number.isFinite(n) && n > 0);
			return amounts.length > 0 ? (amounts[1] ?? amounts[0]) : null;
		});
	} catch {
		return null;
	}
}

async function scrapeCalendarDays(
	page: import("playwright").Page,
	listingId: string,
	start: string,
	end: string,
): Promise<CalendarDay[] | null> {
	let resolveCalendar: (days: CalendarDay[] | null) => void;
	const calendarPromise = new Promise<CalendarDay[] | null>((resolve) => {
		resolveCalendar = resolve;
	});

	const onResponse = async (res: import("playwright").Response) => {
		if (!res.url().includes("PdpAvailabilityCalendar")) return;
		try {
			const json = (await res.json()) as CalendarResponse;
			const days =
				json.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths?.flatMap(
					(m) => m.days ?? [],
				) ?? null;
			resolveCalendar(days);
		} catch {
			resolveCalendar(null);
		}
	};

	page.on("response", onResponse);
	try {
		await page.goto(roomUrl(listingId, start, end), {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
		await page
			.waitForSelector('[aria-label="Kalendarz"]', { timeout: 20_000 })
			.catch(() => {});
		const days = await Promise.race([
			calendarPromise,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
		]);
		if (!days) lastCalendarError = "calendar response not captured";
		return days;
	} catch (err) {
		lastCalendarError = String(err).slice(0, 160);
		return null;
	} finally {
		page.off("response", onResponse);
	}
}

async function scrapeMaxGuests(
	page: import("playwright").Page,
): Promise<number | null> {
	return page.evaluate(() => {
		const text =
			document.querySelector<HTMLScriptElement>("script#data-deferred-state-0")
				?.textContent ?? "";
		const m = text.match(/"maxGuestCapacity":\s*(\d+)/);
		return m ? Number(m[1]) : null;
	});
}

export async function runAirbnbCalendarImport(
	opts: { missingOnly?: boolean } = {},
): Promise<{
	listings: number;
	days: number;
	failures: number;
	monthlyRows: number;
}> {
	// Prioritized rotation: new listings first, then check-in-soon (dynamic
	// pricing window), then oldest-observed. `last_obs`/`next_date` come
	// from the availability snapshots.
	// Precomputed cutoff date avoids mixing params inside strftime args.
	const soonCutoff = new Date(Date.now() + CHECKIN_SOON_DAYS * 86_400_000)
		.toISOString()
		.slice(0, 10);
	const rows = await db.all<{
		id: number;
		externalId: string;
		price: number | null;
	}>(sql`
		SELECT l.id, l.externalId, l.price AS price
		FROM listings l
		LEFT JOIN (
			SELECT listing_id,
			       max(captured_at) AS last_obs,
			       min(date) FILTER (WHERE date >= strftime('%Y-%m-%d','now')) AS next_date
			FROM availability
			WHERE price_config = 'calendar'
			GROUP BY listing_id
		) a ON a.listing_id = l.id
		WHERE l.source = 'airbnb'
		  AND l.is_active = 1
		  AND l.externalId != ''
		  ${opts.missingOnly ? sql`AND a.listing_id IS NULL` : sql``}
		ORDER BY
			CASE
				WHEN a.listing_id IS NULL THEN 0
				WHEN a.next_date IS NOT NULL
				     AND a.next_date <= ${soonCutoff} THEN 1
				ELSE 2
			END,
			COALESCE(a.last_obs, 0) ASC,
			l.id
	`);

	// camoufox keeps its injected window size when no viewport is requested.
	const browser = await launchBrowser();
	const context = await browser.newContext({ viewport: null });
	const page = await context.newPage();

	let observations = 0;
	let failures = 0;
	try {
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			const now = new Date();
			// First future month, then 11 more.
			const monthStarts: Array<{ start: string; end: string }> = [];
			for (let m = 0; m < MONTHS; m++) {
				const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
				const y = d.getFullYear();
				const mo = String(d.getMonth() + 1).padStart(2, "0");
				monthStarts.push({
					start: `${y}-${mo}-01`,
					end: `${y}-${mo}-08`,
				});
			}

			const days = await scrapeCalendarDays(
				page,
				row.externalId,
				monthStarts[0].start,
				monthStarts[0].end,
			);
			if (!days) {
				failures++;
				consecutiveFailures++;
				if (consecutiveFailures >= FAILURE_BREAK) {
					console.error(
						`airbnb-calendar: ${FAILURE_BREAK} consecutive failures — ` +
							`aborting run (likely rate-limited). Last: ${lastCalendarError}`,
					);
					break;
				}
				continue;
			}
			consecutiveFailures = 0;

			const maxGuests = await scrapeMaxGuests(page);
			if (maxGuests != null) {
				await db
					.update(listings)
					.set({ maxGuests })
					.where(eq(listings.id, row.id));
			}

			const nightly = row.price ?? null;
			// Read a 7-night payable total for every month to capture seasonality.
			const monthlyTotals: Array<{
				start: string;
				end: string;
				total: number | null;
			}> = [];
			for (const range of monthStarts) {
				const total = await scrapeStayTotal(
					page,
					row.externalId,
					range.start,
					range.end,
					2,
				);
				monthlyTotals.push({ ...range, total });
			}

			// Capture how the first month's price changes with guest count.
			const guestCap = Math.min(maxGuests ?? 2, 2);
			const guestTotals: Array<{ adults: number; total: number | null }> = [];
			for (let adults = 1; adults <= guestCap; adults++) {
				const total = await scrapeStayTotal(
					page,
					row.externalId,
					monthStarts[0].start,
					monthStarts[0].end,
					adults,
				);
				guestTotals.push({ adults, total });
			}

			// Stay probes matching REAL rental patterns (weekends, extended
			// weekends, work weeks, whole weeks, 10/14-day stays) — each
			// checked in on its typical weekday inside the first month:
			//   1n transit · 2n Fri weekend · 3n Thu extended weekend ·
			//   5n Mon work week · 7n Sat whole week · 10n · 14n
			interface StayProbe {
				config: string;
				start: string;
				end: string;
				nights: number;
				total: number | null;
			}
			const stayProbes: StayProbe[] = [];
			{
				const [y, mo] = [
					Number(monthStarts[0].start.slice(0, 4)),
					Number(monthStarts[0].start.slice(5, 7)) - 1,
				];
				const daysInMonth = new Date(y, mo + 1, 0).getDate();
				const dayDate = (d: number): string =>
					`${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
				const findDow = (target: number): string | null => {
					for (let d = 1; d <= daysInMonth; d++) {
						if (new Date(y, mo, d).getDay() === target) return dayDate(d);
					}
					return null;
				};
				const iso = (base: string, plus: number): string => {
					const d = new Date(
						Number(base.slice(0, 4)),
						Number(base.slice(5, 7)) - 1,
						Number(base.slice(8, 10)) + plus,
					);
					return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
				};
				const probes: Array<{
					config: string;
					start: string;
					nights: number;
				}> = [
					{ config: "1n", start: monthStarts[0].start, nights: 1 },
					{ config: "2n_fri", start: findDow(5) ?? "", nights: 2 },
					{ config: "3n_thu", start: findDow(4) ?? "", nights: 3 },
					{ config: "5n_mon", start: findDow(1) ?? "", nights: 5 },
					{ config: "7n_sat", start: findDow(6) ?? "", nights: 7 },
					{ config: "10n", start: monthStarts[0].start, nights: 10 },
					{ config: "14n", start: monthStarts[0].start, nights: 14 },
				];
				for (const probe of probes) {
					if (!probe.start) continue;
					const end = iso(probe.start, probe.nights);
					if (end > monthStarts[0].end) continue; // keep probe inside month 0
					const total = await scrapeStayTotal(
						page,
						row.externalId,
						probe.start,
						end,
						2,
					);
					stayProbes.push({
						config: probe.config,
						start: probe.start,
						end,
						nights: probe.nights,
						total,
					});
				}
			}

			const baseObservations = days.map((d) => {
				const date = d.calendarDate ?? "";
				const match = monthlyTotals.find(
					(r) => date >= r.start && date < r.end,
				);
				const effective =
					match && match.total != null ? match.total / 7 : nightly;
				return {
					listingId: row.id,
					source: "airbnb",
					date,
					priceConfig: "calendar",
					listedPrice: nightly,
					totalPrice: match ? match.total : null,
					stayNights: match ? 7 : null,
					effectiveNightlyPrice: effective,
					taxes: null,
					fees: null,
					available: d.available === true,
					minimumNights: d.minNights ?? null,
				};
			});

			const guestObservations = days
				.filter((d) => {
					const date = d.calendarDate ?? "";
					return date >= monthStarts[0].start && date < monthStarts[0].end;
				})
				.flatMap((d) =>
					guestTotals.map((g) => ({
						listingId: row.id,
						source: "airbnb",
						date: d.calendarDate ?? "",
						priceConfig: `7_nights_${g.adults}_adults`,
						listedPrice: nightly,
						totalPrice: g.total,
						stayNights: 7,
						effectiveNightlyPrice: g.total != null ? g.total / 7 : nightly,
						taxes: null,
						fees: null,
						available: d.available === true,
						minimumNights: d.minNights ?? null,
					})),
				);

			const stayProbeObservations = days.flatMap((d) => {
				const date = d.calendarDate ?? "";
				return stayProbes
					.filter((sp) => date >= sp.start && date < sp.end)
					.map((sp) => ({
						listingId: row.id,
						source: "airbnb",
						date,
						priceConfig: sp.config,
						listedPrice: nightly,
						totalPrice: sp.total,
						stayNights: sp.nights,
						effectiveNightlyPrice:
							sp.total != null ? sp.total / sp.nights : nightly,
						taxes: null,
						fees: null,
						available: d.available === true,
						minimumNights: d.minNights ?? null,
					}));
			});

			await saveAvailabilityObservations([
				...baseObservations,
				...guestObservations,
				...stayProbeObservations,
			]);
			observations +=
				baseObservations.length +
				guestObservations.length +
				stayProbeObservations.length;

			if ((i + 1) % 25 === 0 || i === rows.length - 1) {
				console.log(
					`airbnb-calendar ${i + 1}/${rows.length}: days=${observations} failures=${failures}`,
				);
			}
			if (LISTING_DELAY_MS > 0) {
				await new Promise((r) => setTimeout(r, LISTING_DELAY_MS));
			}
		}
	} finally {
		await browser.close();
	}

	const monthlyRows = await foldMonthlyPrices();
	// Blocked-vs-booked classification + weekday/month occupancy stats.
	const occupancy = await foldOccupancy();
	console.log(
		`occupancy: listings=${occupancy.listings} ` +
			`months=${occupancy.occupancyRows} weekdayRows=${occupancy.weekdayRows}`,
	);
	return {
		listings: rows.length,
		days: observations,
		failures,
		monthlyRows,
	};
}

async function main(): Promise<void> {
	const missingOnly = process.argv.includes("--missing-only");
	const summary = await runAirbnbCalendarImport({ missingOnly });
	console.log(
		`done: listings=${summary.listings} days=${summary.days} ` +
			`failures=${summary.failures} monthlyRows=${summary.monthlyRows}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
