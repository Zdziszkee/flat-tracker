/**
 * Cross-market dependence for scenario simulation.
 *
 * A full dynamic factor model needs overlapping histories that this project
 * is still collecting. The reduced-form equivalent used here is a common
 * correlated scenario draw per market: correlations are estimated from
 * aligned out-of-sample residuals where they exist, shrunk hard for small
 * samples, and otherwise set to documented priors.
 */

import { mean, pearsonCorrelation } from "./core";
import type { SeriesResidual } from "./univariate";

export type MarketTarget = "price" | "rent" | "str";

const PRIOR_CORRELATION: Record<string, number> = {
	"price|rent": 0.45,
	"price|str": 0.3,
	"rent|str": 0.35,
};

export function pairKey(a: MarketTarget, b: MarketTarget): string {
	return [a, b].sort().join("|");
}

export function priorCorrelation(a: MarketTarget, b: MarketTarget): number {
	if (a === b) return 1;
	return PRIOR_CORRELATION[pairKey(a, b)] ?? 0.25;
}

function alignedPairs(
	a: readonly SeriesResidual[],
	b: readonly SeriesResidual[],
): { x: number[]; y: number[] } {
	const byTime = new Map<number, number>();
	for (const residual of a) byTime.set(residual.t, residual.value);
	const x: number[] = [];
	const y: number[] = [];
	for (const residual of b) {
		const other = byTime.get(residual.t);
		if (other == null) continue;
		x.push(other);
		y.push(residual.value);
	}
	return { x, y };
}

export interface CorrelationEstimate {
	r: number;
	n: number;
	source: "estimated" | "prior";
}

/**
 * Estimate one pairwise correlation. With fewer than four shared residuals
 * the prior is used; above that the estimate is shrunk by n/(n+8), so even a
 * lucky short sample cannot create strong spurious dependence.
 */
export function estimateCorrelation(
	a: readonly SeriesResidual[],
	b: readonly SeriesResidual[],
	targetA: MarketTarget,
	targetB: MarketTarget,
): CorrelationEstimate {
	const { x, y } = alignedPairs(a, b);
	const raw = pearsonCorrelation(x, y);
	if (raw == null || x.length < 4) {
		return {
			r: priorCorrelation(targetA, targetB),
			n: x.length,
			source: "prior",
		};
	}
	const weight = x.length / (x.length + 8);
	return {
		r: raw * weight + priorCorrelation(targetA, targetB) * (1 - weight),
		n: x.length,
		source: "estimated",
	};
}

/** Average pairwise estimates from several geographies, weighted by n. */
export function poolCorrelations(
	estimates: readonly CorrelationEstimate[],
	fallback: number,
): number {
	const usable = estimates.filter((estimate) => estimate.n >= 4);
	if (usable.length === 0) return fallback;
	const total = usable.reduce((sum, estimate) => sum + estimate.n, 0);
	const weighted = usable.reduce(
		(sum, estimate) => sum + estimate.r * estimate.n,
		0,
	);
	return mean([weighted / total, fallback]) ?? fallback;
}
