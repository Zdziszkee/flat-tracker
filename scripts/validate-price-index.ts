/**
 * Validate the pure price-index math: chain-linking and time-adjustment.
 * Run with `bun run validate:price-index`.
 */
import {
	chainStratifiedIndex,
	observationsFromMedianRows,
	timeAdjustment,
} from "../src/lib/valuation/price-index.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

// Chain: first quarter index 100, later links compound.
const chained = chainStratifiedIndex([
	{
		period: "2025-Q1",
		overallMedian: 10000,
		overallCount: 20,
		strata: [{ band: "b35-60", median: 9500, count: 8 }],
	},
	{
		period: "2025-Q2",
		overallMedian: 10500,
		overallCount: 22,
		strata: [{ band: "b35-60", median: 9975, count: 9 }],
	},
]);
check(chained.length === 2, "chain has two quarters");
check(chained[0]?.indexValue === 100, "first quarter index is 100");
check(
	chained[1]?.indexValue != null &&
		chained[1]!.indexValue > 100 &&
		chained[1]!.indexValue < 110,
	"second quarter compounds the stratum ratio",
);

// Time adjustment: factor = latest / from.
const series = [
	{ period: "2025-Q1", indexValue: 100, sampleCount: 20 },
	{ period: "2025-Q2", indexValue: 105, sampleCount: 22 },
	{ period: "2025-Q3", indexValue: 110, sampleCount: 24 },
] as const;
const adj = timeAdjustment(
	series.map((p) => ({
		segment: "flat" as const,
		geographyType: "region" as const,
		geographyKey: "malopolskie",
		source: "rcn",
		medianPriceM2: null,
		...p,
	})),
	"2025-Q1",
	"2025-Q3",
);
check(adj != null, "time adjustment found");
check(adj?.factor === 1.1, "time adjustment factor is 1.1");
check(adj?.fromPeriod === "2025-Q1", "from period correct");
check(adj?.toPeriod === "2025-Q3", "to period correct");

// Outlier rejection: a >2x quarterly jump is skipped.
const outlier = chainStratifiedIndex([
	{
		period: "2025-Q1",
		overallMedian: 10000,
		overallCount: 20,
		strata: [{ band: "b35-60", median: 9500, count: 8 }],
	},
	{
		period: "2025-Q2",
		overallMedian: 25000,
		overallCount: 22,
		strata: [{ band: "b35-60", median: 23750, count: 9 }],
	},
]);
check(outlier.length === 1, "outlier quarter is skipped");

// Too-small sample rejected.
const small = chainStratifiedIndex([
	{
		period: "2025-Q1",
		overallMedian: 10000,
		overallCount: 4,
		strata: [],
	},
]);
check(small.length === 0, "small sample rejected");

// Band rows without an overall median must still reach the chain: only the
// rows at the overall-median positions carry that value, and dropping the
// rest once left each quarter with a single band.
const folded = observationsFromMedianRows([
	{
		period: "2025-Q1",
		areaBand: "a<35",
		bandN: 12,
		bandMedian: 12000,
		overallN: 40,
		overallMedian: null,
	},
	{
		period: "2025-Q1",
		areaBand: "b35-60",
		bandN: 20,
		bandMedian: 10000,
		overallN: 40,
		overallMedian: null,
	},
	{
		period: "2025-Q1",
		areaBand: "c60-90",
		bandN: 8,
		bandMedian: 9000,
		overallN: 40,
		overallMedian: 10250,
	},
]);
check(folded.length === 1, "median rows fold into one observation per period");
check(folded[0]?.strata.length === 3, "every area band is kept");
check(folded[0]?.overallMedian === 10250, "overall median is carried once");
check(folded[0]?.overallCount === 40, "overall count is the period count");
check(
	observationsFromMedianRows([
		{
			period: "2025-Q1",
			areaBand: "a<35",
			bandN: 5,
			bandMedian: 11000,
			overallN: 0,
			overallMedian: null,
		},
	]).length === 0,
	"a period with no overall median is dropped",
);

if (failures > 0) {
	console.error(`\n${failures} price-index check(s) failed.`);
	process.exit(1);
}
console.log("\nAll price-index checks passed.");
