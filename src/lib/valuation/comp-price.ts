/**
 * Pure comparable-price conversion, shared by the RCN and listing paths.
 *
 * RCN transactions are brought forward with the chain-linked quarterly index
 * (nominal, so inflation and real growth sit inside `timeFactor`). Asking
 * listings are not a transaction at all, so they are converted with the
 * measured asking-to-transaction ratio instead. Both are then corrected for
 * the comp's size: a 35 m² unit and a 90 m² unit do not trade at the same
 * zł/m², and the comp band alone cannot express that.
 *
 * Keeping the rules in one pure function means the validator can prove the
 * asking ratio is never applied to an RCN comp, the time factor is never
 * applied to a listing, and the size exponent is never negative.
 *
 * No DB, no clock, no framework imports.
 */

export type CompPriceSource = "rcn" | "listing";

/**
 * Positive area elasticity of zł/m²: a comp A is scaled to the target T with
 * `(A / T) ** beta`, so `beta > 0` raises the implied value of a small target
 * (a 90 m² comp at 10k zł/m² becomes ~11.3k for a 40 m² target) and lowers a
 * large one. Fitted per segment in `scripts/backtest-comp-metric.ts`
 * on held-out RCN transactions; the numbers below are its out-of-sample MAE
 * results (see the module header there).
 *
 * Measured out-of-sample MedAPE (backtest-comp-metric.ts):
 *
 *   segment   beta 0   beta 0.1   beta 0.15   beta 0.25   fitted
 *   flat      14.8%      15.0%       15.0%       15.0%     -0.06 (raw slope)
 *   house     27.4%      27.2%       26.8%       26.5%      0.71 (land-mix
 *                                                          artifact)
 *   plot      38.3%      36.7%       36.0%       34.9%      0.91
 *
 * Flats: beta 0. The comp area band already keeps the size mix narrow, and a
 * fixed correction only adds error. The raw cross-section is also
 * confounded (larger flats sit in better locations, so its slope is slightly
 * negative).
 * Houses: beta 0. Fixed betas gain 2-3 pp in the raw estimator comparison but
 * only 0.2 pp on top of the tuned selection (19.1% -> 18.9% MedAPE), which is
 * not worth extrapolating a confounded slope for.
 * Plots: beta 0.9. Land genuinely gets cheaper per m² as the parcel grows;
 * with the index guard this moves plot MedAPE 38.3% -> 27.6% (MAPE 85% ->
 * 64%, ±20% 27.6% -> 41.2%) and the fitted slope (0.91, R² 0.40) agrees.
 */
export const AREA_ELASTICITY = {
	flat: 0,
	house: 0,
	plot: 0.9,
} as const;

export interface SizeAdjustmentInput {
	beta: number;
	compAreaM2: number | null | undefined;
	targetAreaM2: number | null | undefined;
}

/**
 * `(compArea / targetArea) ** beta`. Missing or non-positive areas yield 1:
 * a size correction is never invented from absent data.
 */
export function sizeAdjustmentFactor(input: SizeAdjustmentInput): number {
	const beta = input.beta;
	const comp = input.compAreaM2;
	const target = input.targetAreaM2;
	if (!Number.isFinite(beta) || beta === 0) return 1;
	if (comp == null || target == null) return 1;
	if (!(comp > 0) || !(target > 0)) return 1;
	const factor = (comp / target) ** beta;
	return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

export interface CompPriceInput {
	source: CompPriceSource;
	/** Face value of the comparable, zł/m². */
	pricePerM2: number;
	/** Time-index factor; RCN only. */
	timeFactor?: number | null;
	/** Asking-to-transaction ratio; listing comps only. */
	askingRatio?: number | null;
	/** Optional size correction applied after the source conversion. */
	size?: SizeAdjustmentInput | null;
}

export interface CompPriceConversion {
	adjustedPriceM2: number;
	/** 1 for listing comps: the asking ratio is not a time adjustment. */
	timeFactor: number;
	/** `asking_ratio` when a listing was converted, else null. */
	indexSource: string | null;
	/** `(compArea / targetArea) ** beta`; 1 when no size correction applies. */
	sizeFactor: number;
}

export function convertCompPrice(input: CompPriceInput): CompPriceConversion {
	const sizeFactor = input.size ? sizeAdjustmentFactor(input.size) : 1;
	if (input.source === "listing") {
		const ratio =
			input.askingRatio != null &&
			Number.isFinite(input.askingRatio) &&
			input.askingRatio > 0
				? input.askingRatio
				: null;
		const base = ratio == null ? input.pricePerM2 : input.pricePerM2 * ratio;
		return {
			adjustedPriceM2: base * sizeFactor,
			timeFactor: 1,
			indexSource: ratio == null ? null : "asking_ratio",
			sizeFactor,
		};
	}
	const factor =
		input.timeFactor != null &&
		Number.isFinite(input.timeFactor) &&
		input.timeFactor > 0
			? input.timeFactor
			: 1;
	return {
		adjustedPriceM2: input.pricePerM2 * factor * sizeFactor,
		timeFactor: factor,
		// The caller records which index series produced the factor.
		indexSource: null,
		sizeFactor,
	};
}

/** One point for the size-elasticity fit. */
export interface AreaPricePoint {
	areaM2: number;
	pricePerM2: number;
}

export interface AreaElasticityFit {
	/** Positive elasticity: -slope of ln(pricePerM2) on ln(areaM2). */
	beta: number;
	n: number;
	r2: number;
}

/**
 * OLS of ln(pricePerM2) on ln(areaM2), returned as the positive elasticity.
 * Used by the backtest and the validator; the production path uses the fitted
 * constants above. Fewer than 50 usable points yields null.
 */
export function fitAreaElasticity(
	points: readonly AreaPricePoint[],
): AreaElasticityFit | null {
	let n = 0;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (const point of points) {
		if (!(point.areaM2 > 0) || !(point.pricePerM2 > 0)) continue;
		if (!Number.isFinite(point.areaM2) || !Number.isFinite(point.pricePerM2)) {
			continue;
		}
		const x = Math.log(point.areaM2);
		const y = Math.log(point.pricePerM2);
		n++;
		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
		syy += y * y;
	}
	if (n < 50) return null;
	const sxxC = sxx - (sx * sx) / n;
	const syyC = syy - (sy * sy) / n;
	const sxyC = sxy - (sx * sy) / n;
	if (!(sxxC > 0)) return null;
	const slope = sxyC / sxxC;
	const r2 = syyC > 0 ? (sxyC * sxyC) / (sxxC * syyC) : 0;
	return { beta: -slope, n, r2 };
}
