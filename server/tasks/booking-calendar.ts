import "nitro/types";
import { defineTask } from "nitro/task";

import { recordCrawlRun } from "#/crawler/db-sink";

/**
 * Daily Booking.com availability/price import (rotation, budgeted). Runs
 * at 03:30, after the Airbnb calendar pass. Same purpose: per-day
 * availability time series + monthly/weekday occupancy folds.
 */
export default defineTask({
	meta: {
		name: "booking-calendar",
		description: "Import Booking.com calendars and fold occupancy stats",
	},
	run: async () => {
		const startedAt = new Date();
		try {
			const { main } = await import("#/crawler/booking-calendar");
			await main();
			await recordCrawlRun({
				source: "booking-calendar",
				startedAt,
				finishedAt: new Date(),
				pages: 0,
				newCount: 0,
				updatedCount: 0,
			});
			return { result: { ok: true } };
		} catch (err) {
			await recordCrawlRun({
				source: "booking-calendar",
				startedAt,
				finishedAt: new Date(),
				pages: 0,
				newCount: 0,
				updatedCount: 0,
				error: String(err),
			});
			throw err;
		}
	},
});
