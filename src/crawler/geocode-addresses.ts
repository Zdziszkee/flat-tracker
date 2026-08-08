import "dotenv/config";

import { geocodeUnlocatedListings } from "./geocode-listings.ts";

/**
 * CLI: geocode every listing that lacks coordinates (full drain).
 *
 * Addresses match the local OSM building index first (fast, offline);
 * the rest go through Nominatim at ~1 req/s. Listings without a stored
 * address get one mined from their title, which is persisted so later
 * runs skip straight to the local index.
 *
 * The hourly refresh runs the same pass with a small Nominatim budget
 * (see refresh.ts), so the backlog here is normally empty.
 */
async function main(): Promise<void> {
	const report = await geocodeUnlocatedListings();
	console.log(
		`done: local=${report.localHits} nominatim=${report.nomHits} ` +
			`titles=${report.titleExtracted} misses=${report.misses} ` +
			`(of ${report.total})`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
