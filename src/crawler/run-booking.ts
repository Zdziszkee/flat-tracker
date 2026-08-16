import "dotenv/config";

import { Effect } from "effect";

import { runCrawl } from "./pipeline.ts";
import { bookingAdapter } from "./sites/booking.ts";

/**
 * Manual runner for the Booking adapter. Booking is DataDome-protected and
 * unverified, so it is intentionally excluded from the shared `adapters`
 * list (and therefore from the hourly refresh) until it has been proven.
 */
async function main(): Promise<void> {
	const report = await Effect.runPromise(runCrawl(bookingAdapter, true));
	console.log(
		`Done in ${report.elapsedSeconds.toFixed(1)}s: ${report.pages} pages, ` +
			`${report.listings} listings (${report.newListings} new, ` +
			`${report.updatedListings} updated)`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
