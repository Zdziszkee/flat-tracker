/**
 * Forward-looking "upside potential" for a sale offer.
 *
 * The fair value in `offer-model.ts` is a backward-looking comparable median.
 * Investment decisions also need the forward side: is the offer cheap or
 * expensive versus the market trend, how strong is that trend, and how much
 * risk sits in the estimate. The 2026 AVM literature (hedonic/GBDT AVMs
 * reporting a point value plus a forecast-standard-deviation band, and
 * investment models using value gap + momentum + risk) converges on the same
 * three factors, which is what this module combines:
 *
 *   value gap      fairM2 vs the asking price (mean reversion)
 *   momentum       the applied index's YoY and 2-year annualized growth,
 *                  damped by half so a hot quarter does not extrapolate
 *   risk           annualized index volatility + comparable dispersion,
 *                  subtracted from the projected return
 *
 * The output is a 12-month expectation, not a promise: it reuses the same
 * price index that adjusted the comparables, so a market whose index is flat
 * gets no growth uplift no matter how the offer is priced.
 */

import type { IndexPoint } from "./price-index";

export interface UpsidePotential {
	horizonMonths: number;
	/** Damped 12-month index growth expectation, in percent. */
	expectedGrowthPct: number;
	/** fairM2 grown by the expectation, zł/m². */
	expectedFairM2: number;
	/** fairM2 / offerM2 - 1, in percent (positive = offer below fair). */
	mispricePct: number | null;
	/** Expected 12-month return: index growth + partial gap convergence. */
	upsidePct: number | null;
	/** Annualized standard deviation of quarterly index returns, percent. */
	volatilityPct: number;
	/** (p75 - p25) / median of the comparable set, percent. */
	compSpreadPct: number;
	/** Risk haircut applied to the projected return, percentage points. */
	riskPenaltyPct: number;
	/** upsidePct - riskPenaltyPct. */
	riskAdjustedUpsidePct: number | null;
	/** 0-100 composite (50 = neutral). */
	score: number;
	label: string;
	tone: string;
	basis: string;
}

const HORIZON_MONTHS = 12;
const MAX_GROWTH = 0.08;
const DAMPING = 0.5;
/**
 * Share of the fair-value gap assumed to close within 12 months. Mean
 * reversion is slow: a flat priced 30% above the local median does not fall
 * 30% in a year, so only ~a third of the gap enters the projection.
 */
const CONVERGENCE = 0.35;
/** Typical dispersion/volatility a buyer already accepts in this market. */
const BASELINE_RISK_PCT = 8;

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

/** Annualized growth from the latest point back ~`quarters` quarters. */
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
	if (years <= 0) return null;
	const ratio = latest.value / from.value;
	if (ratio <= 0) return null;
	return ratio ** (1 / years) - 1;
}

/** Annualized volatility from quarterly log returns (gaps included). */
function annualizedVolatility(
	points: ReadonlyArray<{ ordinal: number; value: number }>,
): number | null {
	const returns: number[] = [];
	for (let i = 1; i < points.length; i++) {
		const previous = points[i - 1];
		const current = points[i];
		if (!previous || !current) continue;
		const quarters = current.ordinal - previous.ordinal;
		if (quarters <= 0 || previous.value <= 0 || current.value <= 0) continue;
		returns.push(Math.log(current.value / previous.value) / quarters);
	}
	if (returns.length < 2) return null;
	const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
	const variance =
		returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
		(returns.length - 1);
	return Math.sqrt(variance) * 2; // 4 quarters per year
}

/** Score and label from the risk-adjusted 12-month upside. */
export function upsideScore(riskAdjustedUpsidePct: number): {
	score: number;
	label: string;
	tone: string;
} {
	const score = Math.round(
		clamp(50 + 50 * Math.tanh(riskAdjustedUpsidePct / 15), 0, 100),
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

	const yoy = annualizedGrowth(points, 4);
	const trend = annualizedGrowth(points, 8);
	const rawGrowth =
		yoy != null && trend != null
			? 0.6 * yoy + 0.4 * trend
			: (yoy ?? trend ?? 0);
	const expectedGrowth = clamp(rawGrowth * DAMPING, -MAX_GROWTH, MAX_GROWTH);

	const volatility = annualizedVolatility(points);
	const volatilityPct = clamp((volatility ?? 0) * 100, 0, 40);
	const compSpreadPct = input.compSpreadPct;
	const riskPenaltyPct = Math.min(
		20,
		0.5 * volatilityPct + 0.15 * compSpreadPct,
	);

	const expectedFairM2 = input.fairM2 * (1 + expectedGrowth);
	const gap =
		input.offerM2 != null && input.offerM2 > 0
			? input.fairM2 / input.offerM2 - 1
			: null;
	const mispricePct = gap == null ? null : gap * 100;
	const upsidePct =
		gap == null ? null : expectedGrowth * 100 + CONVERGENCE * gap * 100;
	const riskAdjustedUpsidePct =
		upsidePct == null ? null : upsidePct - riskPenaltyPct;
	// The 0-100 score is relative attractiveness: a fairly priced flat in a
	// typical-risk market is neutral (50). Only risk above the baseline a
	// buyer already accepts is subtracted, while the reported
	// risk-adjusted upside keeps the full haircut.
	const excessRiskPct = Math.max(0, riskPenaltyPct - BASELINE_RISK_PCT);
	const scored = upsideScore(
		upsidePct == null ? -excessRiskPct : upsidePct - excessRiskPct,
	);

	const basisParts: string[] = [];
	if (gap != null) basisParts.push(`luka ${percent(gap)}`);
	if (yoy != null) basisParts.push(`YoY ${percent(yoy)}`);
	if (trend != null) basisParts.push(`2 lata ${percent(trend)}/rok`);
	if (volatility != null) {
		basisParts.push(`zmienność ${(volatility * 100).toFixed(1)}%/rok`);
	}
	basisParts.push(`spread porównań ${compSpreadPct.toFixed(0)}%`);
	return {
		horizonMonths: HORIZON_MONTHS,
		expectedGrowthPct: Math.round(expectedGrowth * 1000) / 10,
		expectedFairM2: Math.round(expectedFairM2),
		mispricePct: mispricePct == null ? null : Math.round(mispricePct * 10) / 10,
		upsidePct: upsidePct == null ? null : Math.round(upsidePct * 10) / 10,
		volatilityPct: Math.round(volatilityPct * 10) / 10,
		compSpreadPct: Math.round(compSpreadPct * 10) / 10,
		riskPenaltyPct: Math.round(riskPenaltyPct * 10) / 10,
		riskAdjustedUpsidePct:
			riskAdjustedUpsidePct == null
				? null
				: Math.round(riskAdjustedUpsidePct * 10) / 10,
		...scored,
		basis: `12 mies.: ${basisParts.join(" · ")}`,
	};
}
