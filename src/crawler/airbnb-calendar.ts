import "dotenv/config";

import { sql } from "drizzle-orm";
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
 * This deliberately does NOT call the Airbnb API with a key. It opens each
 * listing page in a real browser like a user and captures the availability
 * response the page itself requests (`PdpAvailabilityCalendar`), then persists
 * the per-day calendar. The nightly asking price is taken from the latest
 * `listings.price` (already scraped from the search page) as the best estimate
 * until per-day prices are also scraped from the rendered page.
 */

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

interface ScrapedCalendar {
	days: CalendarDay[];
	totalPrice: number | null;
	stayNights: number;
	startDate: string;
	endDate: string;
}

async function scrapeCalendar(
	page: import("playwright").Page,
	listingId: string,
): Promise<ScrapedCalendar | null> {
	const now = new Date();
	const year =
		now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
	const month = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
	const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
	const endDate = `${year}-${String(month).padStart(2, "0")}-08`;
	const stayNights = 7;
	// Open with a selected 7-night range so the page shows the payable total.
	const url = `https://www.airbnb.pl/rooms/${listingId}?check_in=${startDate}&check_out=${endDate}&adults=2`;

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
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
		await page.waitForSelector('[aria-label="Kalendarz"]', { timeout: 20_000 });
		const days = await Promise.race([
			calendarPromise,
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
		]);
		const totalPrice = await page.evaluate(() => {
			const text =
				document.querySelector<HTMLElement>('[data-testid="book-it-default"]')
					?.innerText ?? "";
			const amounts = [...text.matchAll(/([\d\s.,]+)\s*zł/g)]
				.map((m) => Number(m[1].replace(/\s/g, "").replace(",", ".")))
				.filter((n) => Number.isFinite(n) && n > 0);
			return amounts.length > 0 ? (amounts[1] ?? amounts[0]) : null;
		});
		if (!days) return null;
		return { days, totalPrice, stayNights, startDate, endDate };
	} finally {
		page.off("response", onResponse);
	}
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
			const scraped = await scrapeCalendar(page, row.externalId);
			if (!scraped) {
				failures++;
			} else {
				const nightly = row.price ?? null;
				const effective =
					scraped.totalPrice != null
						? scraped.totalPrice / scraped.stayNights
						: nightly;
				await saveAvailabilityObservations(
					scraped.days.map((d) => {
						const date = d.calendarDate ?? "";
						const inRange = date >= scraped.startDate && date < scraped.endDate;
						return {
							listingId: row.id,
							source: "airbnb",
							date,
							priceConfig: "calendar",
							listedPrice: nightly,
							totalPrice: inRange ? scraped.totalPrice : null,
							stayNights: inRange ? scraped.stayNights : null,
							effectiveNightlyPrice: inRange ? effective : nightly,
							taxes: null,
							fees: null,
							available: d.available === true,
							minimumNights: d.minNights ?? null,
						};
					}),
				);
				observations += scraped.days.length;
			}
			if ((i + 1) % 10 === 0 || i === rows.length - 1) {
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
