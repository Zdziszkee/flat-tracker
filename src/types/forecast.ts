/** Shared API shapes for the probabilistic investment forecast. */

import type { ForecastQuality } from "#/lib/forecast/univariate";

export interface ForecastBandDto {
	p10: number;
	p50: number;
	p90: number;
	mean: number;
}

export interface ForecastEvidenceDto {
	target: "price" | "rent" | "str";
	geographyType: string;
	geographyKey: string;
	segment: string;
	method: string;
	quality: ForecastQuality;
	observations: number;
	latestSample: number | null;
	maePct: number | null;
	coverage80: number | null;
	coverage80OneYear: number | null;
	prior: boolean;
}

export interface AppreciationHorizonDto {
	years: number;
	meanPct: number;
	p10Pct: number;
	p90Pct: number;
}

export interface StrategyHorizonDto {
	years: number;
	/** Annualized IRR, percent. */
	irr: ForecastBandDto | null;
	totalReturnPct: ForecastBandDto;
	probabilityLossPct: number;
	expectedShortfallIrrPct: number | null;
	annualNetIncomeYear1: number;
}

export interface StrategyForecastDto {
	simulations: number;
	initialOutlay: number;
	year1NetIncome: number;
	horizons: StrategyHorizonDto[];
}

export interface OfferForecastDto {
	generatedAt: string | null;
	quality: {
		price: ForecastQuality;
		rent: ForecastQuality;
		str: ForecastQuality;
	};
	evidence: {
		price: ForecastEvidenceDto | null;
		rent: ForecastEvidenceDto | null;
		str: ForecastEvidenceDto | null;
	};
	appreciation: AppreciationHorizonDto[];
	strategies: {
		ltr: StrategyForecastDto | null;
		str: StrategyForecastDto | null;
	};
	assumptions: {
		modelVersion: number;
		years: number[];
		simulations: number;
		acquisitionCostPct: number;
		sellingCostPct: number;
		strExpenseRatioPct: number;
		financing: "unlevered";
	};
	notes: string[];
}
