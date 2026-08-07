import "dotenv/config";

import {
	assignBuildingsToListings,
	assignBuildingsToTransactions,
} from "./geocode.ts";

/**
 * Assigns OSM buildings to every listing and transaction that has
 * coordinates but no building yet. Queries the free Overpass API
 * (point-in-polygon), so it is rate-limited on purpose.
 *
 * Usage: npm run assign-buildings
 */
async function main() {
	console.log("Assigning buildings to listings...");
	const listingsDone = await assignBuildingsToListings();
	console.log(`  ${listingsDone} listings assigned`);

	console.log("Assigning buildings to transactions...");
	const txDone = await assignBuildingsToTransactions();
	console.log(`  ${txDone} transactions assigned`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
