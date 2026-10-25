/**
 * Deterministic checks for the forecasting and cash-flow engine.
 * Run with `bun run validate:forecast`.
 */

import {
	cholesky,
	mulberry32,
	normalDraw,
	periodFromOrdinal,
	periodOrdinal,
	quantile,
	weightedQuantile,
} from "../src/lib/forecast/core.ts";
import { estimateCorrelation } from "../src/lib/forecast/joint.ts";
import { forecastUnivariate } from "../src/lib/forecast/univariate.ts";
import {
	irrAnnual,
	pathPointAt,
	simulateInvestment,
} from "../src/lib/valuation/cash-flow.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}
function near(
	a: number | null,
	b: number | null,
	tolerance: number,
): boolean {
	return a != null && b != null && Math.abs(a - b) <= tolerance;
}

check(periodOrdinal("2026-09") === 2026 * 12 + 8, "month ordinal");
check(periodOrdinal("2026-Q3") === 2026 * 4 + 2, "quarter ordinal");
check(periodOrdinal("2026-13") === null, "invalid month rejected");
check(periodFromOrdinal(2026 * 12 + 8, "month") === "2026-09", "month roundtrip");
check(periodFromOrdinal(2026 * 4 + 2, "quarter") === "2026-Q3", "quarter roundtrip");
check(near(quantile([1, 2, 3, 4], 0.5), 2.5, 1e-9), "median of even sample");
check(
	near(
		weightedQuantile(
			[
				{ value: 1, weight: 1 },
				{ value: 10, weight: 3 },
			],
			0.5,
		),
		10,
		1e-9,
	),
	"weighted quantile respects weights",
);

const chol = cholesky([
	[1, 0.5],
	[0.5, 1],
]);
check(near(chol[0]?.[0] ?? null, 1, 1e-9), "cholesky diagonal");
check(near(chol[1]?.[0] ?? null, 0.5, 1e-9), "cholesky off-diagonal");
check(near(chol[1]?.[1] ?? null, Math.sqrt(0.75), 1e-9), "cholesky completes");

const rngA = mulberry32(42);
const rngB = mulberry32(42);
check(rngA() === rngB() && rngA() === rngB(), "seeded RNG is deterministic");
const normal = normalDraw(mulberry32(7));
check(Number.isFinite(normal), "normal draw is finite");

// Synthetic quarterly log series with a clear upward trend.
const trend = Array.from({ length: 36 }, (_, i) => ({
	period: periodFromOrdinal(2018 * 4 + i, "quarter"),
	value: 100 * Math.exp(0.012 * i + 0.01 * Math.sin(i * 1.7)),
}));
const trendForecast = forecastUnivariate(trend, {
	frequency: "quarter",
	horizon: 12,
	longRunAnnualGrowth: 0.035,
});
check(trendForecast.steps.length === 12, "forecast emits requested horizon");
check(trendForecast.backtest != null, "backtest produced for real history");
check(
	(trendForecast.steps[3]?.mean ?? 0) > trendForecast.latestValue,
	"upward trend continues upward",
);
check(
	trendForecast.steps.every((step) => step.p10 <= step.p90 && step.mean > 0),
	"forecast bands are ordered and positive",
);
check(trendForecast.residuals.length > 0, "out-of-sample residuals retained");

// Strong deterministic seasonality should select the seasonal candidate.
const seasonal = Array.from({ length: 60 }, (_, i) => {
	const month = i % 12;
	const seasonalFactor = month === 6 ? 1.5 : month === 0 ? 0.6 : 1;
	return {
		period: periodFromOrdinal(2021 * 12 + i, "month"),
		value: 100 * Math.exp(0.003 * i) * seasonalFactor,
	};
});
const seasonalForecast = forecastUnivariate(seasonal, {
	frequency: "month",
	horizon: 24,
});
check(
	seasonalForecast.backtest?.method === "seasonal-ar1",
	`seasonal model wins on seasonal data (${seasonalForecast.backtest?.method})`,
);
check(
	(seasonalForecast.backtest?.coverage80 ?? 0.8) >= 0.5 &&
		(seasonalForecast.backtest?.coverage80 ?? 0.8) <= 1,
	"coverage is a valid proportion",
);

const prior = forecastUnivariate([], {
	frequency: "month",
	horizon: 6,
	priorLevel: 50,
	annualVolatility: 0.1,
});
check(prior.method === "prior" && prior.quality === "low", "empty history uses prior");
check(near(prior.latestValue, 50, 1e-9), "prior level is honoured");
check(
	prior.steps.every((step) => step.p10 < step.mean && step.mean < step.p90),
	"prior bands bracket the mean",
);

const flatPath = {
	latestValue: 100,
	frequency: "quarter" as const,
	steps: [1, 2, 3, 4].map((h) => ({
		period: periodFromOrdinal(2026 * 4 + h, "quarter"),
		mean: 100 + h,
		p10: 100 + h - 2,
		p90: 100 + h + 2,
	})),
};
const point = pathPointAt(flatPath, 12);
check(near(point.meanLog, Math.log(1.04), 1e-9), "path multiplier at one year");
check(point.sigmaLog > 0, "path volatility is positive");

check(near(irrAnnual(100, [110]), 0.1, 1e-6), "one-year IRR");
check(near(irrAnnual(100, [0, 121]), 0.1, 1e-6), "two-year IRR");
check(irrAnnual(100, [0, 0]) === null, "no sign change means no IRR");

const deterministicInput = {
	seed: 123,
	simulations: 40,
	years: [1, 3],
	buyPrice: 500_000,
	currentValue: 500_000,
	year1NetIncome: 30_000,
	correlation: 0.4,
	acquisitionCostPct: 0,
	sellingCostPct: 0,
	pricePath: {
		latestValue: 100,
		frequency: "quarter" as const,
		steps: Array.from({ length: 20 }, (_, i) => ({
			period: periodFromOrdinal(2026 * 4 + i + 1, "quarter"),
			mean: 100 * Math.exp(0.01 * (i + 1)),
			p10: 100 * Math.exp(0.01 * (i + 1)),
			p90: 100 * Math.exp(0.01 * (i + 1)),
		})),
	},
	incomePath: {
		latestValue: 100,
		frequency: "month" as const,
		steps: Array.from({ length: 60 }, (_, i) => ({
			period: periodFromOrdinal(2026 * 12 + i + 1, "month"),
			mean: 100 * Math.exp(0.002 * (i + 1)),
			p10: 100 * Math.exp(0.002 * (i + 1)),
			p90: 100 * Math.exp(0.002 * (i + 1)),
		})),
	},
};
const simA = simulateInvestment(deterministicInput);
const simB = simulateInvestment(deterministicInput);
check(
	JSON.stringify(simA) === JSON.stringify(simB),
	"simulation is reproducible for the same seed",
);
check(
	(simA.horizons[0]?.irr?.p50 ?? 0) > 0.03,
	"positive net income produces positive IRR",
);
const expectedYear1CashFlow =
	30_000 * Math.exp(0.002 * 12) + 500_000 * Math.exp(0.01 * 4);
check(
	near(
		simA.horizons[0]?.irr?.p50 ?? null,
		expectedYear1CashFlow / 500_000 - 1,
		1e-6,
	),
	"simulated one-year IRR matches independent cash-flow math",
);
const expectedYear3CashFlows = [1, 2, 3].map(
	(year) => 30_000 * Math.exp(0.002 * 12 * year),
);
expectedYear3CashFlows[2] =
	(expectedYear3CashFlows[2] ?? 0) + 500_000 * Math.exp(0.01 * 12);
check(
	near(
		simA.horizons[1]?.irr?.p50 ?? null,
		irrAnnual(500_000, expectedYear3CashFlows),
		1e-6,
	),
	"simulated three-year IRR matches independent cash-flow math",
);
check(
	simA.horizons.every((horizon) => horizon.probabilityLossPct === 0),
	"deterministic profitable scenario has no losses",
);

const priorCorr = estimateCorrelation([], [], "price", "rent");
check(priorCorr.source === "prior" && near(priorCorr.r, 0.45, 1e-9), "correlation prior");

const { buildOfferForecast, clearForecastCache } = await import(
	"../src/lib/valuation/forecast-service.ts"
);
clearForecastCache();
const offerForecast = await buildOfferForecast({
	offerId: 1,
	segment: "flat",
	lat: 50.03278,
	lng: 19.895767,
	buyPrice: 900_000,
	currentValue: 900_000,
	ltNetYearly: 80_000,
	strGrossYearly: 60_000,
});
check(
	offerForecast.appreciation.length === 3 &&
		offerForecast.appreciation.every(
			(horizon) => horizon.p10Pct <= horizon.meanPct,
		),
	"offer forecast exposes 1/3/5y appreciation",
);
check(
	offerForecast.strategies.ltr?.horizons.length === 3 &&
		offerForecast.strategies.str?.horizons.length === 3,
	"offer forecast exposes LTR and STR IRR horizons",
);
check(
	offerForecast.strategies.ltr?.horizons.every(
		(horizon) =>
			horizon.irr != null &&
			horizon.irr.p10 <= horizon.irr.p50 &&
			horizon.irr.p50 <= horizon.irr.p90,
	) ?? false,
	"IRR distributions are ordered",
);
check(
	offerForecast.notes.length > 0,
	"forecast carries assumptions and data notes",
);

if (failures > 0) {
	console.error(`\n${failures} forecast validation check(s) failed`);
	process.exit(1);
}
console.log("\nAll forecast validation checks passed");
