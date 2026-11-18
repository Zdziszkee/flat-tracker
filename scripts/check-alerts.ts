/**
 * Print today's alert list and check it against the rules that produced it.
 *
 * The leaderboard is a policy artefact, not a table dump: it must not repeat
 * an offer that two portals syndicated, must not fill a column with one
 * investment's price list, must not quote a discount the plausibility gates
 * reject, and must not stand an offer on a placeholder coordinate. Those
 * invariants span SQL and JS, so this tool reads the stored alerts, groups
 * them exactly like `run.ts` does, and fails loudly when the list disagrees.
 *
 *   bun run check:alerts
 *   bun run check:alerts -- --date 2026-11-18 --segment flat
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingAlerts, listingScores, listings } from "#/db/schema";
import { ALERT_GATES, ALERT_MAX_PER_INVESTMENT, SCORE_VERSION } from "#/lib/scoring/config";
import {
	isPlaceholderListing,
	loadPlaceholderPoints,
} from "#/lib/scoring/placeholder-points";

const args = process.argv.slice(2);
const dateArg = args.indexOf("--date");
const segmentArg = args.indexOf("--segment");

const date =
	dateArg >= 0
		? args[dateArg + 1]
		: (
				await db
					.select({ date: listingAlerts.alertDate })
					.from(listingAlerts)
					.orderBy(desc(listingAlerts.alertDate))
					.limit(1)
			)[0]?.date;
if (!date) {
	console.log("no alerts stored");
	process.exit(0);
}
const segment = segmentArg >= 0 ? args[segmentArg + 1] : null;

const rows = await db
	.select({
		rank: listingAlerts.rank,
		segment: listingAlerts.segment,
		score: listingAlerts.score,
		listingId: listings.id,
		source: listings.source,
		title: listings.title,
		city: listings.city,
		street: listings.street,
		areaM2: listings.areaM2,
		price: listings.price,
		pricePerM2: listings.pricePerM2,
		investmentId: listings.investmentId,
		investmentTitle: listings.investmentTitle,
		lat: listings.lat,
		lng: listings.lng,
		buildingId: listings.buildingId,
		discountPct: listingScores.discountPct,
		confidence: listingScores.confidence,
		compCount: listingScores.compCount,
		fairM2: listingScores.fairM2,
		eligible: listingScores.eligible,
		scoreVersion: listingScores.scoreVersion,
		timeFactor: sql<
			number | null
		>`json_extract(${listingScores.valuationJson}, '$.timeFactorMedian')`,
	})
	.from(listingAlerts)
	.innerJoin(listings, eq(listingAlerts.listingId, listings.id))
	.leftJoin(listingScores, eq(listingAlerts.scoreId, listingScores.id))
	.where(
		segment
			? and(eq(listingAlerts.alertDate, date), eq(listingAlerts.segment, segment))
			: eq(listingAlerts.alertDate, date),
	)
	.orderBy(desc(listingScores.eligible), listingAlerts.rank);

const placeholders = await loadPlaceholderPoints();
const problems: string[] = [];
const bySegment = new Map<string, typeof rows>();
for (const row of rows) {
	const bucket = bySegment.get(row.segment) ?? [];
	bucket.push(row);
	bySegment.set(row.segment, bucket);
}

const money = (value: number | null) =>
	value == null ? "-" : Math.round(value).toLocaleString("pl-PL");
const pct = (value: number | null) =>
	value == null ? "-" : `${value.toFixed(1)}%`;

for (const [name, group] of bySegment) {
	console.log(`\n=== ${name} (${group.length}) ===`);
	const seenDuplicates = new Map<string, number>();
	const perInvestment = new Map<string, number>();
	for (const row of group) {
		const dupKey = [
			(row.city ?? "").toLowerCase(),
			(row.street ?? "").toLowerCase().replace(/\bul\.?\s+/g, "").trim(),
			Math.round(row.areaM2 ?? 0),
			Math.round((row.price ?? 0) / Math.max(1000, (row.price ?? 0) * 0.01)),
		].join("|");
		seenDuplicates.set(dupKey, (seenDuplicates.get(dupKey) ?? 0) + 1);
		const invKey =
			row.investmentId?.trim() ||
			row.investmentTitle?.trim().toLowerCase() ||
			null;
		if (invKey) perInvestment.set(invKey, (perInvestment.get(invKey) ?? 0) + 1);
		console.log(
			[
				`#${row.rank}`,
				`id ${row.listingId}`,
				row.source,
				`${row.city ?? "?"}${row.street ? ` / ${row.street}` : ""}`,
				`${row.areaM2 != null ? Math.round(row.areaM2) : "?"} m²`,
				`${money(row.price)} zł`,
				`${money(row.pricePerM2)} zł/m²`,
				`fair ${money(row.fairM2)} zł/m²`,
				`-${pct(row.discountPct)}`,
				`conf ${pct((row.confidence ?? 0) * 100)}`,
				`comps ${row.compCount ?? 0}`,
				`idx ×${row.timeFactor?.toFixed(2) ?? "-"}`,
				row.scoreVersion === SCORE_VERSION ? "" : `[${row.scoreVersion}]`,
				invKey ? `inv ${invKey}` : "",
			]
				.filter(Boolean)
				.join(" · "),
		);
		if (row.eligible !== true) problems.push(`${row.listingId} is not eligible`);
		if (
			row.discountPct != null &&
			row.discountPct >= ALERT_GATES.maxDiscountPct
		) {
			problems.push(`${row.listingId} discount ${pct(row.discountPct)}`);
		}
		if (
			row.timeFactor != null &&
			(row.timeFactor > ALERT_GATES.maxIndexFactor ||
				row.timeFactor < ALERT_GATES.minIndexFactor)
		) {
			problems.push(`${row.listingId} index ×${row.timeFactor.toFixed(2)}`);
		}
		if (
			isPlaceholderListing(placeholders, {
				id: row.listingId,
				lat: row.lat,
				lng: row.lng,
				street: row.street,
				buildingId: row.buildingId,
				investmentId: row.investmentId,
			})
		) {
			problems.push(`${row.listingId} placeholder coordinates`);
		}
	}
	for (const [key, count] of seenDuplicates) {
		if (count > 1) problems.push(`${name} duplicate ${key} x${count}`);
	}
	for (const [key, count] of perInvestment) {
		if (count > ALERT_MAX_PER_INVESTMENT) {
			problems.push(`${name} investment ${key} x${count}`);
		}
	}
}

console.log(`\ndate ${date}`);
if (problems.length === 0) {
	console.log("all leaderboard checks passed");
} else {
	console.log(`${problems.length} problem(s):`);
	for (const problem of problems) console.log(`  - ${problem}`);
	process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
