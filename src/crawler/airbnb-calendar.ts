import "dotenv/config";

import { eq, sql } from "drizzle-orm";
import { chromium } from "playwright";

import { db } from "#/db/index";
import { listings } from "#/db/schema";
import {
	foldMonthlyPrices,
	saveAvailabilityObservations,
} from "./availability.ts";

/**
 * Airbnb availability-calendar importer, browser-first.
 *
 * Simulates a user: opens each listing page in a real browser, captures the
 * availability response the page itself requests, and selects a 7-night stay
 * in each of the next 12 months to read the month's payable total. This
 * captures seasonality (June vs January) instead of one flat nightly price.
 */

const MONTHS = 12;

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
	await page.goto(roomUrl(listingId, start, end, adults), {
		waitUntil: "domcontentloaded",
		timeout: 30_000,
	});
	await page.waitForSelector('[aria-label="Kalendarz"]', { timeout: 20_000 });
	return page.evaluate(() => {
		const text =
			document.querySelector<HTMLElement>('[data-testid="book-it-default"]')
				?.innerText ?? "";
		const amounts = [...text.matchAll(/([\d\s.,]+)\s*zł/g)]
			.map((m) => Number(m[1].replace(/\s/g, "").replace(",", ".")))
			.filter((n) => Number.isFinite(n) && n > 0);
		return amounts.length > 0 ? (amounts[1] ?? amounts[0]) : null;
	});
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
		await page.waitForSelector('[aria-label="Kalendarz"]', { timeout: 20_000 });
		return await Promise.race([
			calendarPromise,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
		]);
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

export async function runAirbnbCalendarImport(): Promise<{
	listings: number;
	days: number;
	failures: number;
	monthlyRows: number;
}> {
	const rows = await db
		.select({
			id: listings.id,
			externalId: listings.externalId,
			price: listings.price,
		})
		.from(listings)
		.where(
			sql`${listings.source} = 'airbnb' and ${listings.isActive} = 1 and ${listings.externalId} != ''`,
		)
		.all();

	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();

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
				continue;
			}

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
			const guestCap = Math.min(maxGuests ?? 2, 4);
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

			// Capture how the first month's price changes with stay length.
			const lengthTotals: Array<{
				nights: number;
				start: string;
				end: string;
				total: number | null;
			}> = [];
			for (const nights of [1, 3, 30]) {
				const start = monthStarts[0].start;
				const startDate = new Date(
					Number(start.slice(0, 4)),
					Number(start.slice(5, 7)) - 1,
					1,
				);
				startDate.setDate(startDate.getDate() + nights);
				const end = `${startDate.getFullYear()}-${String(
					startDate.getMonth() + 1,
				).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
				const total = await scrapeStayTotal(
					page,
					row.externalId,
					start,
					end,
					2,
				);
				lengthTotals.push({ nights, start, end, total });
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

			const lengthObservations = days.flatMap((d) => {
				const date = d.calendarDate ?? "";
				return lengthTotals
					.filter((lt) => date >= lt.start && date < lt.end)
					.map((lt) => ({
						listingId: row.id,
						source: "airbnb",
						date,
						priceConfig: `${lt.nights}_nights_2_adults`,
						listedPrice: nightly,
						totalPrice: lt.total,
						stayNights: lt.nights,
						effectiveNightlyPrice:
							lt.total != null ? lt.total / lt.nights : nightly,
						taxes: null,
						fees: null,
						available: d.available === true,
						minimumNights: d.minNights ?? null,
					}));
			});

			await saveAvailabilityObservations([
				...baseObservations,
				...guestObservations,
				...lengthObservations,
			]);
			observations +=
				baseObservations.length +
				guestObservations.length +
				lengthObservations.length;

			if ((i + 1) % 5 === 0 || i === rows.length - 1) {
				console.log(
					`airbnb-calendar ${i + 1}/${rows.length}: days=${observations} failures=${failures}`,
				);
			}
		}
	} finally {
		await browser.close();
	}

	const monthlyRows = await foldMonthlyPrices();
	return {
		listings: rows.length,
		days: observations,
		failures,
		monthlyRows,
	};
}

async function main(): Promise<void> {
	const summary = await runAirbnbCalendarImport();
	console.log(
		`done: listings=${summary.listings} days=${summary.days} ` +
			`failures=${summary.failures} monthlyRows=${summary.monthlyRows}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
