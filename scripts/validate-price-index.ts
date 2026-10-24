/**
 * Validate the pure price-index math: chain-linking and time-adjustment.
 * Run with `bun run validate:price-index`.
 */
import {
	chainStratifiedIndex,
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

if (failures > 0) {
	console.error(`\n${failures} price-index check(s) failed.`);
	process.exit(1);
}
console.log("\nAll price-index checks passed.");
