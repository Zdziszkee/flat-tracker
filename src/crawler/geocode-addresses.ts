import "dotenv/config";
import { rm } from "node:fs/promises";

import { ADDRESS_ONLY_SOURCES } from "./address-sources.ts";
import {
	geocodeUnlocatedListings,
	NOM_CACHE_PATH,
} from "./geocode-listings.ts";

/**
 * CLI: geocode every listing that lacks coordinates (full drain).
 *
 * Addresses match the local OSM building index first (fast, offline);
 * the rest go through Nominatim at ~1 req/s. Listings without a stored
 * address get one mined from their title, which is persisted so later
 * runs skip straight to the local index.
 *
 * The hourly refresh runs the same pass with a small Nominatim budget
 * (see refresh.ts), so the backlog here is normally empty. Pass
 * `--local-only` to skip Nominatim entirely (e.g. while the shared
 * instance is throttling), or `--reset` to drop every address-only
 * source's stored coordinates first and re-anchor the whole feed.
 */
async function main(): Promise<void> {
	const localOnly = process.argv.includes("--local-only");
	const reset = process.argv.includes("--reset");

	if (reset) {
		// Old cached Nominatim results may reflect the previous matcher; a
		// reset must re-query from a clean slate.
		await rm(NOM_CACHE_PATH, { force: true });
	}

	const sources = reset ? [...ADDRESS_ONLY_SOURCES] : undefined;
	const report = await geocodeUnlocatedListings({
		nominatimLimit: localOnly ? 0 : undefined,
		sources,
		resetSources: reset ? [...ADDRESS_ONLY_SOURCES] : undefined,
	});
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
