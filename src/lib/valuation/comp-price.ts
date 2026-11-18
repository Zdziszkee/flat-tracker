/**
 * Pure comparable-price conversion, shared by the RCN and listing paths.
 *
 * RCN transactions are brought forward with the chain-linked quarterly index
 * (nominal, so inflation and real growth sit inside `timeFactor`). Asking
 * listings are not a transaction at all, so they are converted with the
 * measured asking-to-transaction ratio instead. Keeping both rules in one
 * pure function means the validator can prove the ratio is never applied to
 * an RCN comp and the time factor is never applied to a listing.
 *
 * No DB, no clock, no framework imports.
 */

export type CompPriceSource = "rcn" | "listing";

export interface CompPriceInput {
	source: CompPriceSource;
	/** Face value of the comparable, zł/m². */
	pricePerM2: number;
	/** Time-index factor; RCN only. */
	timeFactor?: number | null;
	/** Asking-to-transaction ratio; listing comps only. */
	askingRatio?: number | null;
}

export interface CompPriceConversion {
	adjustedPriceM2: number;
	/** 1 for listing comps: the asking ratio is not a time adjustment. */
	timeFactor: number;
	/** `asking_ratio` when a listing was converted, else null. */
	indexSource: string | null;
}

export function convertCompPrice(input: CompPriceInput): CompPriceConversion {
	if (input.source === "listing") {
		const ratio =
			input.askingRatio != null &&
			Number.isFinite(input.askingRatio) &&
			input.askingRatio > 0
				? input.askingRatio
				: null;
		return {
			adjustedPriceM2:
				ratio == null ? input.pricePerM2 : input.pricePerM2 * ratio,
			timeFactor: 1,
			indexSource: ratio == null ? null : "asking_ratio",
		};
	}
	const factor =
		input.timeFactor != null &&
		Number.isFinite(input.timeFactor) &&
		input.timeFactor > 0
			? input.timeFactor
			: 1;
	return {
		adjustedPriceM2: input.pricePerM2 * factor,
		timeFactor: factor,
		// The caller records which index series produced the factor.
		indexSource: null,
	};
}
