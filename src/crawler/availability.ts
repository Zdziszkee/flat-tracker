import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import {
	availability,
	availabilityHistory,
	listingMonthlyPrice,
} from "#/db/schema";

/**
 * Availability/price observation storage. Every crawl writes the latest
 * snapshot into `availability` and appends a time-series row into
 * `availabilityHistory`, so lead-time and realized-price analytics can
 * reconstruct how a night's price moved as check-in approached.
 */

export interface AvailabilityObservation {
	listingId: number;
	source: string;
	/** Night date as YYYY-MM-DD. */
	date: string;
	priceConfig: string;
	listedPrice: number | null;
	totalPrice: number | null;
	stayNights: number | null;
	effectiveNightlyPrice: number | null;
	taxes: number | null;
	fees: number | null;
	available: boolean;
	minimumNights: number | null;
}

export async function saveAvailabilityObservations(
	observations: AvailabilityObservation[],
): Promise<number> {
	if (observations.length === 0) return 0;

	const now = new Date();
	const rows = observations.map((o) => ({
		listingId: o.listingId,
		source: o.source,
		date: o.date,
		priceConfig: o.priceConfig,
		listedPrice: o.listedPrice,
		totalPrice: o.totalPrice,
		stayNights: o.stayNights,
		effectiveNightlyPrice: o.effectiveNightlyPrice,
		taxes: o.taxes,
		fees: o.fees,
		available: o.available,
		minimumNights: o.minimumNights,
		capturedAt: now,
	}));

	const BATCH = 400;
	for (let i = 0; i < rows.length; i += BATCH) {
		const chunk = rows.slice(i, i + BATCH);
		await db
			.insert(availability)
			.values(chunk)
			.onConflictDoUpdate({
				target: [
					availability.listingId,
					availability.date,
					availability.priceConfig,
				],
				set: {
					source: sql.raw(`excluded.source`),
					listedPrice: sql.raw(`excluded.listed_price`),
					totalPrice: sql.raw(`excluded.total_price`),
					stayNights: sql.raw(`excluded.stay_nights`),
					effectiveNightlyPrice: sql.raw(`excluded.effective_nightly_price`),
					taxes: sql.raw(`excluded.taxes`),
					fees: sql.raw(`excluded.fees`),
					available: sql.raw(`excluded.available`),
					minimumNights: sql.raw(`excluded.minimum_nights`),
					capturedAt: sql.raw(`excluded.captured_at`),
				},
			});
	}

	await db.insert(availabilityHistory).values(
		rows.map((r) => ({
			listingId: r.listingId,
			source: r.source,
			date: r.date,
			priceConfig: r.priceConfig,
			listedPrice: r.listedPrice,
			totalPrice: r.totalPrice,
			stayNights: r.stayNights,
			effectiveNightlyPrice: r.effectiveNightlyPrice,
			taxes: r.taxes,
			fees: r.fees,
			available: r.available,
			minimumNights: r.minimumNights,
			observedAt: now,
		})),
	);

	return rows.length;
}

/** Rebuild `listing_monthly_price` from the latest `availability` snapshots. */
export async function foldMonthlyPrices(): Promise<number> {
	await db.run(sql`DELETE FROM listing_monthly_price`);
	await db.run(sql`
		INSERT INTO listing_monthly_price (
			listing_id, month, avg_listed_price, avg_effective_nightly_price,
			min_price, max_price, sample_days, booked_nights, captured_at
		)
		SELECT
			listing_id,
			substr(date, 1, 7) AS month,
			avg(listed_price) AS avg_listed_price,
			avg(effective_nightly_price) AS avg_effective_nightly_price,
			min(effective_nightly_price) AS min_price,
			max(effective_nightly_price) AS max_price,
			count(*) AS sample_days,
			sum(case when available = 0 then 1 else 0 end) AS booked_nights,
			unixepoch() AS captured_at
		FROM availability
		GROUP BY listing_id, month;
	`);

	const row = await db
		.select({ count: sql<number>`count(*)` })
		.from(listingMonthlyPrice)
		.get();
	return row?.count ?? 0;
}
