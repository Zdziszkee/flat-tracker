/**
 * Import the City of Kraków's planned/completed public-investment KML maps.
 * The hourly refresh runs this weekly; use `--force` to refresh now.
 *
 *   bun run import:public-investments -- --force
 */
import { importPublicInvestments } from "../src/crawler/public-investments.ts";

const force = process.argv.includes("--force");
const result = await importPublicInvestments({ force });
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
