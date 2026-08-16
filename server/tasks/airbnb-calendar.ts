import "nitro/types";
import { defineTask } from "nitro/task";

import { runAirbnbCalendarImport } from "#/crawler/airbnb-calendar";

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
		const summary = await runAirbnbCalendarImport();
		console.log(
			`[airbnb-calendar] listings=${summary.listings} days=${summary.days} ` +
				`failures=${summary.failures} monthlyRows=${summary.monthlyRows}`,
		);
		return { result: summary };
	},
});
