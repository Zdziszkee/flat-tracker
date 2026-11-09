/**
 * One-off / manual rebuild of the denormalized listing fields
 * (`property_kind`, `is_visible`, `map_lat`, `map_lng`, `derived_at`).
 *
 * The hourly refresh already runs this at the end of every crawl. Use the
 * script after a migration, after changing the visibility rule, or after a
 * manual `assign-buildings` run that moved building centroids.
 */
import { recomputeListingDerived } from "../src/db/listing-derived.ts";

const report = recomputeListingDerived();
console.log(
	`[listing-derived] ${report.rows} rows scanned, ${report.visible} visible, ` +
		`${report.changed} changed in ${report.elapsedMs} ms`,
);
