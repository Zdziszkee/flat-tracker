/**
 * On-disk contract for `data/forecasts/models.json`.
 *
 * The builder refreshes models from whatever history exists and appends the
 * current month's rent/STR observations to `history`, so the same file is
 * both the model artifact and the slowly accumulating panel. Models whose
 * history is still too short are explicit `method: "prior"` entries.
 */

import type { ForecastFrequency } from "./core";
import type { MarketTarget } from "./joint";
import type {
	ForecastQuality,
	SeriesForecast,
	SeriesObservation,
	SeriesScale,
} from "./univariate";

export const FORECAST_ARTIFACT_VERSION = 1;
export const FORECAST_ARTIFACT_PATH = "data/forecasts/models.json";

export type ForecastGeography =
	| "region"
	| "grid10"
	| "external_city"
	| "district";

export interface StoredSeriesModel extends SeriesForecast {
	target: MarketTarget;
	geographyType: ForecastGeography;
	geographyKey: string;
	/** flat | house | plot | all. */
	segment: string;
	frequency: ForecastFrequency;
	scale: SeriesScale;
	observations: number;
	/** Number of underlying listings/transactions in the latest observation. */
	latestSample: number | null;
}

export interface MarketSnapshot extends SeriesObservation {
	target: MarketTarget;
	geographyType: ForecastGeography;
	geographyKey: string;
	segment: string;
	/** Number of listings behind this median/weighted mean. */
	samples: number;
	/**
	 * Month the observation was captured (YYYY-MM). For STR calendar rows
	 * this is not the calendar month being observed: bookings for 2027-07
	 * captured in 2026-10 are a forecast for 2027-07, not a history point.
	 */
	capturedAt?: string;
}

export interface StoredCorrelation {
	geographyKey: string;
	priceRent: number;
	priceStr: number;
	rentStr: number;
}

export interface ForecastArtifact {
	version: number;
	generatedAt: string;
	models: StoredSeriesModel[];
	history: MarketSnapshot[];
	correlations: Record<string, StoredCorrelation>;
}

export function modelKey(model: {
	target: MarketTarget;
	geographyType: ForecastGeography;
	geographyKey: string;
	segment: string;
}): string {
	return [
		model.target,
		model.geographyType,
		model.geographyKey,
		model.segment,
	].join(":");
}

export function qualityRank(quality: ForecastQuality): number {
	return quality === "high" ? 3 : quality === "medium" ? 2 : 1;
}
