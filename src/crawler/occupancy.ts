/**
 * Occupancy analytics folded from the latest availability snapshots.
 *
 * The core problem: an unavailable night is EITHER a real booking OR an
 * owner block (closed season, unopened far-future months). Naively
 * counting "unavailable = booked" overestimates occupancy badly.
 *
 * Heuristic classification of consecutive unavailable runs per listing:
 * - run bounded by available nights on both sides  -> BOOKED (a stay that
 *   fits between open windows; owners rarely block interior gaps)
 * - run touching the horizon start, short (<= 14 d) -> BOOKED (a stay that
 *   began before our first observation)
 * - run reaching the horizon end (rest of horizon) -> BLOCKED if long
 *   (> BLOCKED_TAIL_DAYS, e.g. unopened months) else BOOKED (recent stay
 *   still running / same-day booking)
 * - interior run longer than BLOCKED_RUN_DAYS (45 d) -> BLOCKED (season
 *   closures show up as month-scale walls, not bookings)
 *
 * Outputs: listing_occupancy (listing x month) and listing_weekday_stats
 * (listing x weekday), both folded from the priceConfig='calendar'
 * snapshot rows written by the calendar importers.
 */

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import {
	listingOccupancy,
	listingWeekdayStats,
} from "#/db/schema";

/** Interior unavailable runs longer than this are owner blocks, not stays. */
const BLOCKED_RUN_DAYS = 45;
/** Tail runs at the horizon end longer than this are unopened months. */
const BLOCKED_TAIL_DAYS = 45;
/** A run that began before our first observation: still plausibly a stay. */
const PRE_HORIZON_BOOKED_MAX = 14;

type Class = "available" | "booked" | "blocked";

interface DayRow {
	date: string;
	available: boolean;
	effective: number | null;
}

function classifyRun(
	run: DayRow[],
	prev: DayRow | null,
	next: DayRow | null,
): Class {
	const len = run.length;
	const touchesStart = prev === null;
	const touchesEnd = next === null;
	if (touchesStart && touchesEnd) return "blocked"; // whole horizon closed
	if (len > BLOCKED_RUN_DAYS) return "blocked";
	if (touchesEnd) return len > BLOCKED_TAIL_DAYS ? "blocked" : "booked";
	if (touchesStart) return len <= PRE_HORIZON_BOOKED_MAX ? "booked" : "blocked";
	return "booked"; // interior gap bounded by open nights
}

export async function foldOccupancy(): Promise<{
	listings: number;
	occupancyRows: number;
	weekdayRows: number;
}> {
	const src = await db.all<{
		listing_id: number;
		date: string;
		available: number;
		effective_nightly_price: number | null;
	}>(sql`
		SELECT listing_id, date, available, effective_nightly_price
		FROM availability
		WHERE price_config = 'calendar'
		ORDER BY listing_id, date
	`);

	// Group per listing.
	const perListing = new Map<number, DayRow[]>();
	for (const r of src) {
		const list = perListing.get(r.listing_id) ?? [];
		list.push({
			date: r.date,
			available: r.available === 1,
			effective: r.effective_nightly_price,
		});
		perListing.set(r.listing_id, list);
	}

	const occRows: Array<typeof listingOccupancy.$inferInsert> = [];
	const dowRows: Array<typeof listingWeekdayStats.$inferInsert> = [];

	for (const [listingId, days] of perListing) {
		// Split into available/unavailable runs, classify runs, tag days.
		const classes = new Array<Class>(days.length).fill("available");
		let i = 0;
		while (i < days.length) {
			if (days[i].available) {
				classes[i] = "available";
				i++;
				continue;
			}
			let j = i;
			while (j < days.length && !days[j].available) j++;
			const run = days.slice(i, j);
			const cls = classifyRun(
				run,
				i > 0 ? days[i - 1] : null,
				j < days.length ? days[j] : null,
			);
			for (let k = i; k < j; k++) classes[k] = cls;
			i = j;
		}

		const months = new Map<
			string,
			{ sample: number; booked: number; blocked: number; available: number; priceSum: number; priceN: number }
		>();
		const weekdays = new Map<
			number,
			{ sample: number; booked: number; available: number; priceSum: number; priceN: number }
		>();
		for (let k = 0; k < days.length; k++) {
			const d = days[k];
			const month = d.date.slice(0, 7);
			const dow = (new Date(`${d.date}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
			const cls = classes[k];
			const m =
				months.get(month) ??
				{ sample: 0, booked: 0, blocked: 0, available: 0, priceSum: 0, priceN: 0 };
			m.sample++;
			if (cls === "booked") m.booked++;
			else if (cls === "blocked") m.blocked++;
			else m.available++;
			if (d.available && d.effective != null) {
				m.priceSum += d.effective;
				m.priceN++;
			}
			months.set(month, m);

			const w =
				weekdays.get(dow) ??
				{ sample: 0, booked: 0, available: 0, priceSum: 0, priceN: 0 };
			w.sample++;
			if (cls === "booked") w.booked++;
			else if (cls === "available") w.available++;
			if (d.available && d.effective != null) {
				w.priceSum += d.effective;
				w.priceN++;
			}
			weekdays.set(dow, w);
		}

		for (const [month, m] of months) {
			occRows.push({
				listingId,
				month,
				sampleDays: m.sample,
				bookedNights: m.booked,
				blockedNights: m.blocked,
				availableNights: m.available,
				occupancyRate: m.sample > 0 ? m.booked / m.sample : null,
				avgAvailablePrice: m.priceN > 0 ? m.priceSum / m.priceN : null,
			});
		}
		for (const [dow, w] of weekdays) {
			dowRows.push({
				listingId,
				weekday: dow,
				sampleDays: w.sample,
				avgEffectiveNightlyPrice: w.priceN > 0 ? w.priceSum / w.priceN : null,
				bookedNights: w.booked,
				availableNights: w.available,
			});
		}
	}

	// Full refresh: derived tables rebuild in one pass.
	await db.run(sql`DELETE FROM listing_occupancy`);
	await db.run(sql`DELETE FROM listing_weekday_stats`);
	for (let i = 0; i < occRows.length; i += 500) {
		await db.insert(listingOccupancy).values(occRows.slice(i, i + 500));
	}
	for (let i = 0; i < dowRows.length; i += 500) {
		await db.insert(listingWeekdayStats).values(dowRows.slice(i, i + 500));
	}

	return {
		listings: perListing.size,
		occupancyRows: occRows.length,
		weekdayRows: dowRows.length,
	};
}
