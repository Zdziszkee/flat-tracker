import "dotenv/config";

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { launchBrowser } from "./browser.ts";
import {
	foldMonthlyPrices,
	saveAvailabilityObservations,
	type AvailabilityObservation,
} from "./availability.ts";
import { foldOccupancy } from "./occupancy.ts";

/**
 * Booking.com availability/price calendar importer.
 *
 * Mirrors the Airbnb calendar flow but for Booking's property pages: for a
 * ROTATION of listings (oldest-observed first, never-observed first) open
 * the property page with a 7-night stay pinned to each of the next
 * MONTHS month-starts and read the payable total. A page that renders no
 * bookable price for the stay is treated as unavailable for that window
 * ("Termin niedostępny" / no "Zarezerwuj" CTA).
 *
 * Cadence: the "booking-calendar" task runs it daily at 03:30 (right
 * after the Airbnb calendar pass) and walks ALL active listings —
 * ~1.7k x 4 loads per night; rate limiting is accepted as an experiment
 * (tune with BOOKING_CALENDAR_DELAY_MS).
 */

const MONTHS = 4;
/** Politeness pause between listings (ms). */
const LISTING_DELAY_MS = Number(process.env.BOOKING_CALENDAR_DELAY_MS ?? 250);

function propertyUrl(externalId: string, start: string, end: string): string {
	return (
		`https://www.booking.com/hotel/${externalId}.pl.html?` +
		new URLSearchParams({
			checkin: start,
			checkout: end,
			group_adults: "2",
			no_rooms: "1",
			group_children: "0",
			lang: "pl",
		}).toString()
	);
}

/**
 * Read the payable total for the pinned stay. Booking renders room rows
 * ("Wybierz pokój") with a total-price cell, or an unavailability notice.
 * Returns null when nothing bookable was found for the window.
 */
async function scrapeStayTotal(
	page: import("playwright").Page,
): Promise<number | null> {
	return page
		.evaluate(() => {
			const text = document.body.innerText ?? "";
			// Unavailability markers (stay window not bookable).
			if (
				/nie ma dostępności|niedostępne|brak dostępności|unavailable/i.test(
					text,
				) &&
				!/zarezerwuj/i.test(text)
			) {
				return null;
			}
			// Prefer explicit price-for-N-nights cells; fall back to the
			// first plausible "X zł" amount in the booking table area.
			const cells = Array.from(
				document.querySelectorAll<HTMLElement>(
					'[data-testid="price-for-x-nights"], .prd-tt-price, .bui-price__value',
				),
			);
			const amounts: number[] = [];
			for (const el of cells) {
				const m = (el.innerText ?? "").match(/([\d\s.,]+)\s*zł/i);
				if (m) {
					const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
					if (Number.isFinite(n) && n > 0) amounts.push(n);
				}
			}
			if (amounts.length === 0) {
				const m = text.match(/([\d\s.,]+)\s*zł/i);
				if (m) {
					const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
					if (Number.isFinite(n) && n > 0) amounts.push(n);
				}
			}
			return amounts.length > 0 ? Math.min(...amounts) : null;
		})
		.catch(() => null);
}

export async function main(): Promise<void> {
	// Rotation: never-observed first, then oldest-observed.
	const rows = await db
		.all<{ id: number; externalId: string }>(sql`
		SELECT l.id, l.external_id AS externalId
		FROM listings l
		LEFT JOIN (
			SELECT listing_id, max(captured_at) AS last_obs
			FROM availability
			GROUP BY listing_id
		) a ON a.listing_id = l.id
		WHERE l.source = 'booking'
		  AND l.is_active = 1
		  AND l.external_id LIKE 'pl/%'
		ORDER BY COALESCE(a.last_obs, 0) ASC, l.id
	`);
	console.log(`booking-calendar: ${rows.length} listings in rotation`);

	const browser = await launchBrowser();
	let observations = 0;
	let successes = 0;
	try {
		const page = await browser.newPage();
		const now = new Date();
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
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

			const obs: AvailabilityObservation[] = [];
			for (const range of monthStarts) {
				await page
					.goto(propertyUrl(row.externalId, range.start, range.end), {
						waitUntil: "domcontentloaded",
						timeout: 45_000,
					})
					.catch(() => {});
				await page
					.waitForSelector('[data-testid="property-section--content"]', {
						timeout: 15_000,
					})
					.catch(() => {});
				const total = await scrapeStayTotal(page);
				obs.push({
					listingId: row.id,
					source: "booking",
					date: range.start,
					priceConfig: "7_nights_2_adults",
					listedPrice: null,
					totalPrice: total,
					stayNights: 7,
					effectiveNightlyPrice: total != null ? total / 7 : null,
					taxes: null,
					fees: null,
					available: total != null,
					minimumNights: null,
				});
			}

			await saveAvailabilityObservations(obs);
			observations += obs.length;
			if (obs.some((o) => o.available)) successes++;
			if ((i + 1) % 25 === 0 || i === rows.length - 1) {
				console.log(
					`booking-calendar ${i + 1}/${rows.length}: obs=${observations} reachable=${successes}`,
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
	const occupancy = await foldOccupancy();
	console.log(
		`done: listings=${rows.length} obs=${observations} reachable=${successes} ` +
			`monthlyRows=${monthlyRows} occupancyRows=${occupancy.occupancyRows}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
