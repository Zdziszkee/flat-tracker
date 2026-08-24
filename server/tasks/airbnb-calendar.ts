import "nitro/types";
import { defineTask } from "nitro/task";

import { runAirbnbCalendarImport } from "#/crawler/airbnb-calendar";
import { recordCrawlRun } from "#/crawler/db-sink";

/**
 * Daily Airbnb availability-calendar import. The hourly refresh keeps the
 * listing catalog fresh; this task adds the per-day availability time series
 * (and folds monthly price aggregates) once a day.
 */
export default defineTask({
	meta: {
		name: "airbnb-calendar",
		description: "Import Airbnb availability calendars and fold monthly prices",
	},
	run: async () => {
		const startedAt = new Date();
		try {
			const summary = await runAirbnbCalendarImport();
			await recordCrawlRun({
				source: "airbnb-calendar",
				startedAt,
				finishedAt: new Date(),
				pages: 0,
				newCount: summary.listings,
				updatedCount: summary.monthlyRows,
			});
			console.log(
				`[airbnb-calendar] listings=${summary.listings} days=${summary.days} ` +
					`failures=${summary.failures} monthlyRows=${summary.monthlyRows}`,
			);
			return { result: summary };
		} catch (err) {
			await recordCrawlRun({
				source: "airbnb-calendar",
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
