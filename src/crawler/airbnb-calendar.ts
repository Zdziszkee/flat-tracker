import "dotenv/config";

import { sql } from "drizzle-orm";
import { db } from "#/db/index";
import { listings } from "#/db/schema";
import {
	foldMonthlyPrices,
	saveAvailabilityObservations,
} from "./availability.ts";

/**
 * Airbnb availability-calendar importer. Calls the public
 * `PdpAvailabilityCalendar` persisted query (same one the listing page uses)
 * once per active Airbnb listing, capturing a rolling 12 months of
 * availability per day. The nightly asking price is taken from the latest
 * `listings.price` as the best available estimate until per-day pricing is
 * captured separately.
 */

const API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";
const CALENDAR_HASH =
	"be60714ead0a30db42ce6471ddad6a8f3855df0ed400b79282dd0bb8cecdf201";
const CALENDAR_URL = `https://www.airbnb.pl/api/v3/PdpAvailabilityCalendar/${CALENDAR_HASH}`;
const MONTHS = 12;

interface CalendarDay {
	calendarDate?: string;
	available?: boolean;
	minNights?: number;
	maxNights?: number;
	price?: { localPriceFormatted?: string | null };
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

async function fetchCalendar(listingId: string): Promise<CalendarDay[] | null> {
	const now = new Date();
	const variables = {
		request: {
			count: MONTHS,
			listingId,
			month: now.getMonth() + 1,
			year: now.getFullYear(),
			returnPropertyLevelCalendarIfApplicable: false,
		},
	};
	const params = new URLSearchParams({
		operationName: "PdpAvailabilityCalendar",
		locale: "pl",
		currency: "PLN",
		variables: JSON.stringify(variables),
		extensions: JSON.stringify({
			persistedQuery: { version: 1, sha256Hash: CALENDAR_HASH },
		}),
	});
	const res = await fetch(`${CALENDAR_URL}?${params}`, {
		headers: {
			"x-airbnb-api-key": API_KEY,
			"content-type": "application/json",
			"user-agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
			referer: `https://www.airbnb.pl/rooms/${listingId}`,
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) return null;
	const json = (await res.json()) as CalendarResponse;
	return (
		json.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths?.flatMap(
			(m) => m.days ?? [],
		) ?? null
	);
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

	let observations = 0;
	let failures = 0;
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const days = await fetchCalendar(row.externalId);
		if (!days) {
			failures++;
		} else {
			const nightly = row.price ?? null;
			await saveAvailabilityObservations(
				days.map((d) => ({
					listingId: row.id,
					source: "airbnb",
					date: d.calendarDate ?? "",
					priceConfig: "calendar",
					listedPrice: nightly,
					totalPrice: null,
					stayNights: null,
					effectiveNightlyPrice: nightly,
					taxes: null,
					fees: null,
					available: d.available === true,
					minimumNights: d.minNights ?? null,
				})),
			);
			observations += days.length;
		}
		if ((i + 1) % 10 === 0 || i === rows.length - 1) {
			console.log(
				`airbnb-calendar ${i + 1}/${rows.length}: days=${observations} failures=${failures}`,
			);
		}
		// Be polite to the public API.
		await new Promise((r) => setTimeout(r, 250));
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
