/**
 * Multi-horizon (1-5 year) upside potential for a sale offer.
 *
 * The fair value in `offer-model.ts` is a backward-looking comparable median;
 * this module projects where an investment in that offer could be in 1, 2, 3
 * and 5 years. It is a statistical forecast, not a SOTA gradient-boosted
 * hedonic AVM: RCN carries no floor/build-year/condition fields to train one
 * on, and inventing them from asking prices would bias the model. What it
 * does implement is the forecasting layer those AVMs report around their
 * point value:
 *
 *   market path   a mean-reverting AR(1) model of quarterly log returns,
 *                 with the long-run mean shrunk toward a 3.5%/yr nominal
 *                 prior instead of extrapolating the 2020-2026 boom
 *   value gap     fairM2 vs the asking price, closed with an exponential
 *                 convergence over ~2 years (partial, not instant)
 *   uncertainty   forecast variance from the residual volatility, turned
 *                 into p10/p50/p90 bands; the risk-adjusted return is the
 *                 mean-variance certainty equivalent (gamma = 2)
 *
 * Nominal, pre-tax, no transaction costs. The output is a projection with
 * explicit assumptions; comparable evidence and the confidence band remain
 * the primary valuation output.
 */

import type { IndexPoint } from "./price-index";

export interface UpsideHorizon {
	months: number;
	/** Expected cumulative price change vs the asking price, percent. */
	expectedUpsidePct: number;
	/** 10th percentile cumulative change, percent. */
	p10UpsidePct: number;
	/** 90th percentile cumulative change, percent. */
	p90UpsidePct: number;
	/** Expected annualized change, percent. */
	annualizedPct: number;
	/** Certainty-equivalent annualized change (risk-adjusted), percent. */
	riskAdjustedAnnualPct: number;
	score: number;
	label: string;
	tone: string;
}

export interface UpsidePotential {
	/** Headline horizon (12 months) fields, kept for the existing UI. */
	horizonMonths: number;
	expectedGrowthPct: number;
	expectedFairM2: number;
	mispricePct: number | null;
	upsidePct: number | null;
	volatilityPct: number;
	compSpreadPct: number;
	riskPenaltyPct: number;
	riskAdjustedUpsidePct: number | null;
	score: number;
	label: string;
	tone: string;
	basis: string;
	/** 1, 2, 3 and 5 year projections. */
	horizons: UpsideHorizon[];
}

const HEADLINE_MONTHS = 12;
const HORIZONS_QUARTERS = [4, 8, 12, 20] as const;
/** Long-run nominal growth prior (income growth + inflation), annualized. */
const LONG_RUN_GROWTH = 0.035;
/** Weight of the recent 2-year trend against the long-run prior. */
const RECENT_WEIGHT = 0.35;
/**
 * Mean reversion of the value gap: ~12 quarters. A flat priced 30% above
 * the local median does not close that gap in a year, so the projection
 * stays deliberately slow.
 */
const GAP_TAU_QUARTERS = 12;
/** Largest cumulative gap contribution, log terms (±30%). */
const MAX_GAP_CONTRIBUTION = 0.3;
/** Model risk the index volatility does not capture (AVM error, fair value). */
const MODEL_SIGMA = 0.06;
/** Mean-variance risk aversion on log returns. */
const RISK_AVERSION = 2;
const Z80 = 1.2815515655446004; // two-sided 80% normal band

/** `2026-Q3` -> a monotonic quarter ordinal, or null for a malformed value. */
export function quarterOrdinal(period: string): number | null {
	const match = period.match(/^(\d{4})-Q([1-4])$/u);
	if (!match?.[1] || !match[2]) return null;
	return Number(match[1]) * 4 + Number(match[2]) - 1;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function percent(value: number, digits = 1): string {
	const sign = value > 0 ? "+" : "";
	return `${sign}${(value * 100).toFixed(digits)}%`;
}

function annualizedGrowth(
	points: ReadonlyArray<{ ordinal: number; value: number }>,
	quarters: number,
): number | null {
	const latest = points[points.length - 1];
	if (!latest || latest.value <= 0) return null;
	const target = latest.ordinal - quarters;
	let from: { ordinal: number; value: number } | undefined;
	for (const point of points) {
		if (point.ordinal <= target) from = point;
		else break;
	}
	if (!from || from.value <= 0 || from.ordinal >= latest.ordinal) return null;
	const years = (latest.ordinal - from.ordinal) / 4;
	const ratio = latest.value / from.value;
	if (years <= 0 || ratio <= 0) return null;
	return ratio ** (1 / years) - 1;
}

interface ReturnStats {
	returns: number[];
	lastReturn: number | null;
	sigmaQuarterly: number;
	phi: number;
	recent2y: number | null;
}

function returnStats(
	points: ReadonlyArray<{ ordinal: number; value: number }>,
): ReturnStats {
	const returns: number[] = [];
	for (let i = 1; i < points.length; i++) {
		const previous = points[i - 1];
		const current = points[i];
		if (!previous || !current) continue;
		const quarters = current.ordinal - previous.ordinal;
		if (quarters <= 0 || previous.value <= 0 || current.value <= 0) continue;
		returns.push(Math.log(current.value / previous.value) / quarters);
	}
	if (returns.length < 2) {
		return {
			returns,
			lastReturn: returns[returns.length - 1] ?? null,
			sigmaQuarterly: 0,
			phi: 0,
			recent2y: annualizedGrowth(points, 8),
		};
	}
	const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
	const variance =
		returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		(returns.length - 1);
	const sigmaQuarterly = Math.sqrt(variance);
	// AR(1) on consecutive returns; weak autocorrelation in housing, so keep
	// the estimate inside [0, 0.6] (no explosive momentum).
	let phi = 0;
	if (returns.length >= 8) {
		const lag = returns.slice(0, -1);
		const current = returns.slice(1);
		const meanLag = lag.reduce((sum, value) => sum + value, 0) / lag.length;
		const meanCur =
			current.reduce((sum, value) => sum + value, 0) / current.length;
		let covariance = 0;
		let varianceLag = 0;
		for (let i = 0; i < lag.length; i++) {
			const l = lag[i] ?? 0;
			const c = current[i] ?? 0;
			covariance += (l - meanLag) * (c - meanCur);
			varianceLag += (l - meanLag) ** 2;
		}
		if (varianceLag > 0) phi = clamp(covariance / varianceLag, 0, 0.6);
	}
	return {
		returns,
		lastReturn: returns[returns.length - 1] ?? null,
		sigmaQuarterly,
		phi,
		recent2y: annualizedGrowth(points, 8),
	};
}

/** Cumulative transitory deviation under AR(1): x0 * phi (1 - phi^h) / (1 - phi). */
function transitorySum(phi: number, x0: number, quarters: number): number {
	if (phi <= 1e-6) return 0;
	return x0 * ((phi * (1 - phi ** quarters)) / (1 - phi));
}

/** Var(sum of h AR(1) forecasts): sigma^2 * sum_u ((1 - phi^u)/(1 - phi))^2. */
function forecastVariance(
	sigmaQuarterly: number,
	phi: number,
	quarters: number,
): number {
	const sigma2 = sigmaQuarterly * sigmaQuarterly;
	if (sigma2 <= 0) return 0;
	if (phi <= 1e-6) return quarters * sigma2;
	let sum = 0;
	for (let u = 1; u <= quarters; u++) {
		const coefficient = (1 - phi ** u) / (1 - phi);
		sum += coefficient * coefficient;
	}
	return sigma2 * sum;
}

export function horizonLabel(months: number): string {
	const years = months / 12;
	if (years === 1) return "1 rok";
	if (years === 2) return "2 lata";
	if (years === 3) return "3 lata";
	if (years === 5) return "5 lat";
	return `${years} lat`;
}

export function horizonScore(riskAdjustedAnnualPct: number): {
	score: number;
	label: string;
	tone: string;
} {
	const score = Math.round(
		clamp(
			50 + 50 * Math.tanh((riskAdjustedAnnualPct - LONG_RUN_GROWTH * 100) / 10),
			0,
			100,
		),
	);
	if (score >= 70) {
		return { score, label: "wysoki potencjał", tone: "text-emerald-600" };
	}
	if (score >= 55) {
		return { score, label: "umiarkowany potencjał", tone: "text-emerald-700" };
	}
	if (score >= 45) return { score, label: "neutralny", tone: "text-gray-600" };
	if (score >= 30) {
		return { score, label: "ograniczony potencjał", tone: "text-amber-600" };
	}
	return { score, label: "niski potencjał", tone: "text-red-600" };
}

export function upsidePotential(input: {
	fairM2: number;
	offerM2: number | null;
	series: readonly IndexPoint[];
	compSpreadPct: number;
}): UpsidePotential | null {
	if (!Number.isFinite(input.fairM2) || input.fairM2 <= 0) return null;
	if (!Number.isFinite(input.compSpreadPct) || input.compSpreadPct < 0) {
		return null;
	}
	const points = input.series
		.map((point) => ({
			ordinal: quarterOrdinal(point.period),
			value: point.indexValue,
		}))
		.filter(
			(point): point is { ordinal: number; value: number } =>
				point.ordinal != null &&
				Number.isFinite(point.value) &&
				point.value > 0,
		)
		.sort((a, b) => a.ordinal - b.ordinal);

	const stats = returnStats(points);
	const sigmaQuarterly = clamp(stats.sigmaQuarterly, 0.01, 0.06);
	const recent2y = stats.recent2y;
	// Shrink the recent trend toward the long-run prior: the 2020-2026 sample
	// contains a boom and high inflation, so extrapolating it for five years
	// would be the single biggest source of over-optimism.
	const muAnnual = clamp(
		RECENT_WEIGHT * (recent2y ?? LONG_RUN_GROWTH) +
			(1 - RECENT_WEIGHT) * LONG_RUN_GROWTH,
		-0.02,
		0.07,
	);
	const muQuarterly = Math.log1p(muAnnual) / 4;
	const x0 = (stats.lastReturn ?? muQuarterly) - muQuarterly;

	const offerM2 = input.offerM2;
	const gap =
		offerM2 != null && offerM2 > 0 ? Math.log(input.fairM2 / offerM2) : null;
	const mispricePct =
		gap == null || offerM2 == null ? null : (input.fairM2 / offerM2 - 1) * 100;

	const horizons: UpsideHorizon[] = HORIZONS_QUARTERS.map((quarters) => {
		const gapContribution =
			gap == null
				? 0
				: clamp(
						(1 - Math.exp(-quarters / GAP_TAU_QUARTERS)) * gap,
						-MAX_GAP_CONTRIBUTION,
						MAX_GAP_CONTRIBUTION,
					);
		const meanLog =
			quarters * muQuarterly +
			transitorySum(stats.phi, x0, quarters) +
			gapContribution;
		const variance =
			forecastVariance(sigmaQuarterly, stats.phi, quarters) +
			MODEL_SIGMA * MODEL_SIGMA;
		const sd = Math.sqrt(variance);
		const expected = Math.exp(meanLog) - 1;
		const p10 = Math.exp(meanLog - Z80 * sd) - 1;
		const p90 = Math.exp(meanLog + Z80 * sd) - 1;
		const certaintyEquivalent =
			Math.exp(meanLog - RISK_AVERSION * variance) - 1;
		const annualized = (1 + expected) ** (4 / quarters) - 1;
		const riskAdjustedAnnual = (1 + certaintyEquivalent) ** (4 / quarters) - 1;
		const scored = horizonScore(riskAdjustedAnnual * 100);
		return {
			months: quarters * 3,
			expectedUpsidePct: Math.round(expected * 1000) / 10,
			p10UpsidePct: Math.round(p10 * 1000) / 10,
			p90UpsidePct: Math.round(p90 * 1000) / 10,
			annualizedPct: Math.round(annualized * 1000) / 10,
			riskAdjustedAnnualPct: Math.round(riskAdjustedAnnual * 1000) / 10,
			...scored,
		};
	});

	const headline = horizons.find((h) => h.months === HEADLINE_MONTHS);
	if (!headline) return null;
	const headlineQuarters = HEADLINE_MONTHS / 3;
	const headlineMeanLog =
		headlineQuarters * muQuarterly +
		transitorySum(stats.phi, x0, headlineQuarters);
	const expectedGrowthPct =
		Math.round((Math.exp(headlineMeanLog) - 1) * 1000) / 10;
	const expectedFairM2 = Math.round(input.fairM2 * Math.exp(headlineMeanLog));
	const volatilityPct = Math.round(sigmaQuarterly * 2 * 1000) / 10;

	const basisParts = [
		`AR(1): μ ${(muAnnual * 100).toFixed(1)}%/rok`,
		`φ ${stats.phi.toFixed(2)}`,
		`σ ${volatilityPct.toFixed(1)}%/rok`,
		`luka ${gap == null ? "—" : percent(Math.exp(gap) - 1)} (τ ${GAP_TAU_QUARTERS} kw., max ${(MAX_GAP_CONTRIBUTION * 100).toFixed(0)}%)`,
		`model σ ${(MODEL_SIGMA * 100).toFixed(0)}%`,
		`spread ${input.compSpreadPct.toFixed(0)}%`,
	];
	return {
		horizonMonths: HEADLINE_MONTHS,
		expectedGrowthPct,
		expectedFairM2,
		mispricePct: mispricePct == null ? null : Math.round(mispricePct * 10) / 10,
		upsidePct: headline.expectedUpsidePct,
		volatilityPct,
		compSpreadPct: Math.round(input.compSpreadPct * 10) / 10,
		riskPenaltyPct:
			Math.round(
				(headline.expectedUpsidePct - headline.riskAdjustedAnnualPct) * 10,
			) / 10,
		riskAdjustedUpsidePct: headline.riskAdjustedAnnualPct,
		score: headline.score,
		label: headline.label,
		tone: headline.tone,
		basis: `12 mies.: ${basisParts.join(" · ")}`,
		horizons,
	};
}
