/**
 * Validate the forward-looking upside math: quarter ordinals, growth
 * annualization, volatility, risk haircut and score. Pure, no DB.
 * Run with `bun run validate:upside`.
 */
import type { IndexPoint } from "../src/lib/valuation/price-index.ts";
import {
	quarterOrdinal,
	upsidePotential,
	upsideScore,
} from "../src/lib/valuation/upside.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

function point(period: string, indexValue: number): IndexPoint {
	return {
		segment: "flat",
		geographyType: "region",
		geographyKey: "malopolskie",
		period,
		indexValue,
		medianPriceM2: null,
		sampleCount: 100,
		source: "rcn",
	};
}

check(quarterOrdinal("2026-Q3") === 2026 * 4 + 2, "quarter ordinal");
check(quarterOrdinal("bad") === null, "malformed quarter rejected");

// Steady +1% per quarter: ~4.06% annualized, damped to ~2.03%.
const steady = Array.from({ length: 13 }, (_, i) => {
	const ordinal = 2023 * 4 + i;
	const year = Math.floor(ordinal / 4);
	const quarter = (ordinal % 4) + 1;
	return point(`${year}-Q${quarter}`, 100 * 1.01 ** i);
});
const steadyUp = upsidePotential({
	fairM2: 10000,
	offerM2: 9000, // 11.1% below fair
	series: steady,
	compSpreadPct: 20,
});
check(steadyUp != null, "steady series produces a result");
check(
	Math.abs((steadyUp?.expectedGrowthPct ?? 0) - 2.0) < 0.2,
	`steady growth is damped to ~2% (${steadyUp?.expectedGrowthPct})`,
);
check(
	(steadyUp?.expectedFairM2 ?? 0) > 10100 &&
		(steadyUp?.expectedFairM2 ?? 0) < 10300,
	"expected fair grows from the fair value",
);
check(
	(steadyUp?.mispricePct ?? 0) > 11 && (steadyUp?.mispricePct ?? 0) < 11.2,
	"misprice is fair/offer - 1",
);
check((steadyUp?.volatilityPct ?? 1) < 0.2, "steady growth has no volatility");
check((steadyUp?.score ?? 0) > 55, "below-fair offer scores above neutral");

// Same series, offer above fair: upside negative, score below neutral.
const overpriced = upsidePotential({
	fairM2: 10000,
	offerM2: 12000,
	series: steady,
	compSpreadPct: 20,
});
check(
	(overpriced?.riskAdjustedUpsidePct ?? 0) < 0,
	"above-fair offer has negative risk-adjusted upside",
);
check((overpriced?.score ?? 100) < 45, "above-fair offer scores below neutral");

// Volatile series: alternating +10% / -10% quarters.
const volatile = Array.from({ length: 9 }, (_, i) => {
	const ordinal = 2024 * 4 + i;
	const year = Math.floor(ordinal / 4);
	const quarter = (ordinal % 4) + 1;
	return point(`${year}-Q${quarter}`, i % 2 === 0 ? 100 : 110);
});
const volatileUp = upsidePotential({
	fairM2: 10000,
	offerM2: 10000,
	series: volatile,
	compSpreadPct: 40,
});
check((volatileUp?.volatilityPct ?? 0) > 10, "volatile series raises volatility");
check(
	(volatileUp?.riskPenaltyPct ?? 0) >
		(steadyUp?.riskPenaltyPct ?? Number.POSITIVE_INFINITY),
	"risk penalty grows with volatility and spread",
);

// Gap: two points four quarters apart, +8% total => ~8% annualized.
const gapped = upsidePotential({
	fairM2: 10000,
	offerM2: 10000,
	series: [point("2024-Q1", 100), point("2025-Q1", 108)],
	compSpreadPct: 10,
});
check(
	Math.abs((gapped?.expectedGrowthPct ?? 0) - 4.0) < 0.2,
	`gapped series annualizes over the gap and damps (${gapped?.expectedGrowthPct})`,
);

// No index series: no growth, but the value gap still yields a score.
const noSeries = upsidePotential({
	fairM2: 10000,
	offerM2: 8000,
	series: [],
	compSpreadPct: 20,
});
check(noSeries?.expectedGrowthPct === 0, "no series means zero growth");
check(
	(noSeries?.score ?? 0) > (steadyUp?.score ?? 0),
	"a larger gap scores higher than a small one",
);

check(upsideScore(0).score === 50, "zero risk-adjusted upside is neutral");
check(upsideScore(60).score === 100, "score is capped at 100");
check(upsideScore(-60).score === 0, "score is floored at 0");

if (failures > 0) {
	console.error(`\n${failures} upside check(s) failed.`);
	process.exit(1);
}
console.log("\nAll upside checks passed.");
