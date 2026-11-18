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
 * `--stale` is the follow-up pass after a rule change lands mid-run: it
 * re-scores the stored scores that the current rules would now reject (a
 * placeholder point, an index factor outside the band, a discount inside the
 * plausibility gates) instead of the whole candidate set. Without it a run
 * that started before the last edit leaves those rows eligible until the next
 * full pass.
 *
 * Progress goes to stderr so the summary stays pipeable:
 *
 *   bun run rescore:candidates
 *   bun run rescore:candidates --all --limit 500
 *   bun run rescore:candidates --force
 *   bun run rescore:candidates --stale
 *   bun run rescore:candidates --dry-run
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingScores, listings } from "#/db/schema";
import { nearestCentreAnchor } from "#/lib/scoring/centre-zone";
import { ALERT_GATES, CENTRE_ZONE, SCORE_VERSION } from "#/lib/scoring/config";
import {
	isPlaceholderListing,
	loadPlaceholderPoints,
} from "#/lib/scoring/placeholder-points";
import { runAlertScoring } from "#/lib/scoring/run";

const args = process.argv.slice(2);
const all = args.includes("--all");
const stale = args.includes("--stale");
/** Re-score the candidates even when they already carry a current-version score. */
const force = args.includes("--force");
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

/**
 * Stored current-version scores that the rules now reject, judged from the
 * values already in the row: the index factor lives in `valuation_json`, the
 * discount and the sample in their columns, and the placeholder flag needs
 * one query over the listing's own coordinates.
 */
async function staleIds(): Promise<number[]> {
	const index = await loadPlaceholderPoints();
	const rows = await db
		.select({
			id: listings.id,
			lat: listings.lat,
			lng: listings.lng,
			street: listings.street,
			buildingId: listings.buildingId,
			investmentId: listings.investmentId,
			discountPct: listingScores.discountPct,
			compCount: listingScores.compCount,
			timeFactor: sql<
				number | null
			>`json_extract(${listingScores.valuationJson}, '$.timeFactorMedian')`,
		})
		.from(listingScores)
		.innerJoin(listings, eq(listingScores.listingId, listings.id))
		.where(
			and(
				eq(listingScores.scoreVersion, SCORE_VERSION),
				eq(listingScores.eligible, true),
			),
		);
	const out: number[] = [];
	for (const row of rows) {
		if (
			isPlaceholderListing(index, {
				id: row.id,
				lat: row.lat,
				lng: row.lng,
				street: row.street,
				buildingId: row.buildingId,
				investmentId: row.investmentId,
			})
		) {
			out.push(row.id);
			continue;
		}
		if (
			row.timeFactor != null &&
			(row.timeFactor > ALERT_GATES.maxIndexFactor ||
				row.timeFactor < ALERT_GATES.minIndexFactor)
		) {
			out.push(row.id);
			continue;
		}
		if (
			row.discountPct != null &&
			row.discountPct >= ALERT_GATES.maxDiscountPct
		) {
			out.push(row.id);
			continue;
		}
		// The bandwidth of the comp sample is not stored with the score, so the
		// stale pass re-scores every offer in the unverified band: the re-run
		// applies the real rule. Over-inclusion costs a second per offer, a
		// stale eligible score costs the leaderboard a false alert.
		if (
			row.discountPct != null &&
			row.discountPct >= ALERT_GATES.unverifiedDiscountPct
		) {
			out.push(row.id);
		}
	}
	return out;
}

const target = stale
	? await staleIds()
	: limit != null && limit > 0
		? ids.slice(0, limit)
		: ids;
const alreadyScored = await db
	.select({ id: listingScores.listingId })
	.from(listingScores)
	.where(eq(listingScores.scoreVersion, SCORE_VERSION));
const fresh = new Set(alreadyScored.map((row) => row.id));
const todo = force ? target : target.filter((id) => !fresh.has(id));

process.stderr.write(
	`rescore: ${todo.length} offers (${target.length} candidates, ${fresh.size} already at ${SCORE_VERSION})${force ? " [force]" : ""}${dryRun ? " [dry run]" : ""}\n`,
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
