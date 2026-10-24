/**
 * Import the city-level flat-price reference (finwire.pl, RCN-derived) into
 * `price_indices` as `external_city` rows. The hourly refresh runs it weekly;
 * use `--force` to refresh now.
 *
 *   bun run import:finwire -- --force
 */
import { importFinwire } from "../src/crawler/import-finwire.ts";

const force = process.argv.includes("--force");
const result = await importFinwire({ force });
console.log(
	JSON.stringify(
		{
			...result,
			note: result.skipped
				? "younger than the 7-day window; pass --force to refresh"
				: undefined,
		},
		null,
		2,
	),
);
