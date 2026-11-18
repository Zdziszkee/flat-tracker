/**
 * Pure summary statistics for a valuation's comparable set.
 *
 * Kept out of `offer-model.ts` so the validator can pin the rules (index span,
 * time-factor median, comparable age) without opening the database. The model
 * passes the working comps, the applied asking ratio and the valuation clock.
 */

import { median } from "#/lib/stats";

export interface StatisticsComp {
	source: "rcn" | "listing";
	date: Date | number | null;
	timeFactor: number;
	indexSource: string | null;
	indexFromPeriod: string | null;
	indexToPeriod: string | null;
}

export interface AskingRatioEvidence {
	ratio: number;
	source: "measured" | "fallback";
}

export interface ValuationStatistics {
	timeFactorMedian: number | null;
	indexSpan: { from: string; to: string } | null;
	askingRatio: number | null;
	askingRatioSource: "measured" | "fallback" | null;
	compAgeMedianYears: number | null;
}

function secondsOf(value: Date | number | null): number | null {
	if (value == null) return null;
	return value instanceof Date ? value.getTime() / 1000 : value;
}

export function estimateStatistics(
	comps: readonly StatisticsComp[],
	asking: AskingRatioEvidence | null,
	nowSeconds: number,
): ValuationStatistics {
	const indexed = comps.filter(
		(comp) => comp.source === "rcn" && comp.indexSource != null,
	);
	const factors = indexed
		.map((comp) => comp.timeFactor)
		.filter((factor) => Number.isFinite(factor) && factor > 0);
	const fromPeriods = indexed
		.map((comp) => comp.indexFromPeriod)
		.filter((period): period is string => period != null)
		.sort();
	const toPeriods = indexed
		.map((comp) => comp.indexToPeriod)
		.filter((period): period is string => period != null)
		.sort();
	const ages = comps
		.map((comp) => secondsOf(comp.date))
		.filter((seconds): seconds is number => seconds != null)
		.map((seconds) => Math.max(0, nowSeconds - seconds) / (365 * 86_400));
	const listingRatio = comps.some((comp) => comp.source === "listing")
		? (asking?.ratio ?? null)
		: null;
	const ageMedian = median(ages);
	const factorMedian = median(factors);
	return {
		timeFactorMedian:
			factorMedian == null ? null : Math.round(factorMedian * 10000) / 10000,
		indexSpan:
			fromPeriods.length > 0 && toPeriods.length > 0
				? {
						from: fromPeriods[0] as string,
						to: toPeriods[toPeriods.length - 1] as string,
					}
				: null,
		askingRatio: listingRatio,
		askingRatioSource: listingRatio == null ? null : (asking?.source ?? null),
		compAgeMedianYears:
			ageMedian == null ? null : Math.round(ageMedian * 10) / 10,
	};
}
