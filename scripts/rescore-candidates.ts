/**
 * Re-score the offers that can plausibly enter today's alert list.
 *
 * A gate or weight change requires a `SCORE_VERSION` bump, and every stored
 * score then belongs to the old version: the leaderboard reads only the
 * current one, so the list goes empty until the pool is re-scored. A full
 * re-score is hours of comparable queries (each offer scans the regional
 * transaction index), while the offers that can actually alert are a small
 * subset: every house and plot (both segments are thin) and the flats inside
 * the centre zone, which is a hard gate for them.
 *
 * Progress goes to stderr so the summary stays pipeable:
 *
 *   bun run rescore:candidates
 *   bun run rescore:candidates --all --limit 500
 *   bun run rescore:candidates --dry-run
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingScores, listings } from "#/db/schema";
import { nearestCentreAnchor } from "#/lib/scoring/centre-zone";
import { CENTRE_ZONE, SCORE_VERSION } from "#/lib/scoring/config";
import { runAlertScoring } from "#/lib/scoring/run";

const args = process.argv.slice(2);
const all = args.includes("--all");
const dryRun = args.includes("--dry-run");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : null;

const rows = await db
	.select({
		id: listings.id,
		kind: listings.propertyKind,
		lat: listings.lat,
		lng: listings.lng,
		city: listings.city,
	})
	.from(listings)
	.where(
		and(
			eq(listings.offerType, "sale"),
			eq(listings.isActive, true),
			eq(listings.isVisible, true),
			isNotNull(listings.price),
			isNotNull(listings.areaM2),
			isNotNull(listings.pricePerM2),
			sql`${listings.price} > 0`,
			sql`${listings.pricePerM2} > 0`,
		),
	);

const ids: number[] = [];
for (const row of rows) {
	if (all) {
		ids.push(row.id);
		continue;
	}
	// Houses and plots: the whole segment competes for its 25 slots.
	if (row.kind === "house" || row.kind === "plot") {
		ids.push(row.id);
		continue;
	}
	if (row.kind !== "apartment" || row.lat == null || row.lng == null) continue;
	// Flats: only those inside the centre zone can pass that gate.
	const zone = nearestCentreAnchor(row.lat, row.lng, row.city);
	if (zone != null && zone.distanceM <= CENTRE_ZONE.radiusM) ids.push(row.id);
}

const target = limit != null && limit > 0 ? ids.slice(0, limit) : ids;
const alreadyScored = await db
	.select({ id: listingScores.listingId })
	.from(listingScores)
	.where(eq(listingScores.scoreVersion, SCORE_VERSION));
const fresh = new Set(alreadyScored.map((row) => row.id));
const todo = target.filter((id) => !fresh.has(id));

process.stderr.write(
	`rescore: ${todo.length} offers (${target.length} candidates, ${fresh.size} already at ${SCORE_VERSION})${dryRun ? " [dry run]" : ""}\n`,
);

const started = Date.now();
const summary = await runAlertScoring({
	all: true,
	listingIds: todo,
	dryRun,
});
const seconds = (Date.now() - started) / 1000;
process.stderr.write(
	`rescore: ${summary.scored} scored, ${summary.eligible} eligible, ${summary.alerts} alerts, ${summary.errors} errors in ${seconds.toFixed(0)}s (${(seconds / Math.max(1, summary.scored)).toFixed(1)}s/offer)\n`,
);
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.errors > 0 ? 1 : 0);
