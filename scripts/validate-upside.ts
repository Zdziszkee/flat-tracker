/**
 * Validate the multi-horizon upside math: quarter ordinals, AR(1) market
 * path, gap convergence, forecast variance, quantile bands and scores.
 * Pure, no DB. Run with `bun run validate:upside`.
 */
import type { IndexPoint } from "../src/lib/valuation/price-index.ts";
import {
	horizonScore,
	quarterOrdinal,
	upsidePotential,
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

function seriesFromReturns(
	startOrdinal: number,
	initial: number,
	returns: readonly number[],
): IndexPoint[] {
	const points: IndexPoint[] = [];
	let value = initial;
	for (let i = 0; i <= returns.length; i++) {
		const ordinal = startOrdinal + i;
		const year = Math.floor(ordinal / 4);
		const quarter = (ordinal % 4) + 1;
		points.push(point(`${year}-Q${quarter}`, value));
		if (i < returns.length) value *= Math.exp(returns[i] ?? 0);
	}
	return points;
}

check(quarterOrdinal("2026-Q3") === 2026 * 4 + 2, "quarter ordinal");
check(quarterOrdinal("bad") === null, "malformed quarter rejected");

// Steady +1% per quarter over 3 years.
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
check(steadyUp?.horizons.length === 4, "four horizons are produced");
check(
	steadyUp?.horizons.map((h) => h.months).join(",") === "12,24,36,60",
	"horizons are 1, 2, 3 and 5 years",
);
check(
	(steadyUp?.expectedGrowthPct ?? 0) > 18 &&
		(steadyUp?.expectedGrowthPct ?? 0) < 22,
	`steady 5y market growth is shrunk toward the 3.5% prior (${steadyUp?.expectedGrowthPct})`,
);
check(
	steadyUp?.horizonMonths === 60,
	"headline potential is the five-year horizon",
);
check(
	Math.abs((steadyUp?.mispricePct ?? 0) - 11.1) < 0.2,
	"misprice is fair/offer - 1",
);
check(
	(steadyUp?.upsidePct ?? 0) > 28 && (steadyUp?.upsidePct ?? 0) < 34,
	`5y upside includes market growth and gap convergence (${steadyUp?.upsidePct})`,
);
check((steadyUp?.score ?? 0) > 55, "below-fair offer scores above neutral");
check(
	(steadyUp?.horizons[3]?.expectedUpsidePct ?? 0) >
		(steadyUp?.horizons[0]?.expectedUpsidePct ?? Number.POSITIVE_INFINITY),
	"5y expected upside exceeds 1y",
);

// Same series, offer above fair.
const overpriced = upsidePotential({
	fairM2: 10000,
	offerM2: 16000,
	series: steady,
	compSpreadPct: 20,
});
check(
	(overpriced?.riskAdjustedUpsidePct ?? 0) < 0,
	"above-fair offer has a negative risk-adjusted return",
);
check((overpriced?.score ?? 100) < 45, "above-fair offer scores below neutral");

// Volatility and quantile bands on an alternating series.
const volatile = seriesFromReturns(
	2024 * 4,
	100,
	Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1)),
);
const volatileUp = upsidePotential({
	fairM2: 10000,
	offerM2: 10000,
	series: volatile,
	compSpreadPct: 40,
});
check((volatileUp?.volatilityPct ?? 0) > 10, "volatile series raises volatility");
for (const horizon of volatileUp?.horizons ?? []) {
	check(
		horizon.p10UpsidePct < horizon.expectedUpsidePct &&
			horizon.expectedUpsidePct < horizon.p90UpsidePct,
		`${horizon.months}m bands bracket the point estimate`,
	);
}
check(
	(volatileUp?.horizons[3]?.p10UpsidePct ?? 0) <
		(volatileUp?.horizons[0]?.p10UpsidePct ?? 0),
	"the 5y downside band is wider than the 1y band",
);

// Gap: only 4 quarters of history, so the 2-year trend is unavailable and
// the long-run prior drives the market path.
const gapped = upsidePotential({
	fairM2: 10000,
	offerM2: 10000,
	series: [point("2024-Q1", 100), point("2025-Q1", 108)],
	compSpreadPct: 10,
});
check(
	(gapped?.expectedGrowthPct ?? 0) > 17 && (gapped?.expectedGrowthPct ?? 0) < 21,
	`a short series compounds the 3.5% prior over five years (${gapped?.expectedGrowthPct})`,
);

// No index series: the prior still drives a market path, gap still counts.
const noSeries = upsidePotential({
	fairM2: 10000,
	offerM2: 8000,
	series: [],
	compSpreadPct: 20,
});
check(
	(noSeries?.expectedGrowthPct ?? 0) > 17 &&
		(noSeries?.expectedGrowthPct ?? 0) < 21,
	"no series compounds the long-run prior over five years",
);
check(
	(noSeries?.score ?? 0) > (steadyUp?.score ?? 0),
	"a larger gap scores higher than a small one",
);

// Mean reversion: a recent jump must not extrapolate linearly over 5 years.
const jump = seriesFromReturns(
	2020 * 4,
	100,
	[...Array.from({ length: 20 }, () => 0), 0.10],
);
const jumpUp = upsidePotential({
	fairM2: 10000,
	offerM2: 10000,
	series: jump,
	compSpreadPct: 10,
});
check(
	(jumpUp?.horizons[3]?.expectedUpsidePct ?? 0) < 30,
	`a one-quarter jump is not extrapolated linearly (${jumpUp?.horizons[3]?.expectedUpsidePct})`,
);

check(horizonScore(3.5).score === 50, "long-run growth is neutral");
check(horizonScore(60).score === 100, "score is capped at 100");
check(horizonScore(-60).score === 0, "score is floored at 0");

if (failures > 0) {
	console.error(`\n${failures} upside check(s) failed.`);
	process.exit(1);
}
console.log("\nAll upside checks passed.");
