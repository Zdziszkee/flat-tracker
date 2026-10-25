/**
 * Offer-level forecast assembly.
 *
 * This layer is intentionally thin: it resolves the best local model from the
 * artifact, falls back to an explicit prior when a market has no history, and
 * turns model paths plus current cash flows into LTR/STR IRR distributions.
 * The heavy math lives in `src/lib/forecast/*` and `cash-flow.ts`.
 */

import { regionOf } from "#/db/region";
import {
	FORECAST_ARTIFACT_PATH,
	type ForecastArtifact,
	qualityRank,
	type StoredSeriesModel,
} from "#/lib/forecast/artifact";
import { PERIODS_PER_YEAR, periodFromOrdinal, Z80 } from "#/lib/forecast/core";
import type { MarketTarget } from "#/lib/forecast/joint";
import { readJsonFile } from "#/lib/json-state";
import {
	type MarketPath,
	pathPointAt,
	type StrategySimulation,
	simulateInvestment,
} from "#/lib/valuation/cash-flow";
import { externalCityFor } from "#/lib/valuation/external-city";
import { grid10Key } from "#/lib/valuation/price-index";
import type {
	ForecastBandDto,
	ForecastEvidenceDto,
	OfferForecastDto,
	StrategyForecastDto,
} from "#/types/forecast";

const CACHE_TTL_MS = 5 * 60_000;
const YEARS = [1, 3, 5];
const SIMULATIONS = 400;
const STR_EXPENSE_RATIO = 0.3;
const ACQUISITION_COST_PCT = 0.03;
const SELLING_COST_PCT = 0.02;

let cache: { artifact: ForecastArtifact | null; loadedAt: number } | null =
	null;

/** Test/dev helper: force the next call to reload the artifact. */
export function clearForecastCache(): void {
	cache = null;
}

async function loadArtifact(): Promise<ForecastArtifact | null> {
	if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
		return cache.artifact;
	}
	const artifact = await readJsonFile<ForecastArtifact>(FORECAST_ARTIFACT_PATH);
	cache = { artifact, loadedAt: Date.now() };
	return artifact;
}

interface GeoContext {
	region: string | null;
	city: string | null;
	grid: string | null;
}

function geoContext(lat: number | null, lng: number | null): GeoContext {
	if (lat == null || lng == null) {
		return { region: null, city: null, grid: null };
	}
	const region = regionOf(lat, lng);
	return {
		region,
		city: externalCityFor(lat, lng, region),
		grid: grid10Key(lat, lng),
	};
}

interface PickOptions {
	target: MarketTarget;
	segment: string;
	geo: GeoContext;
}

function pickModel(
	artifact: ForecastArtifact | null,
	options: PickOptions,
): StoredSeriesModel | null {
	if (!artifact) return null;
	const priorities: Array<{
		geographyType: StoredSeriesModel["geographyType"];
		geographyKey: string | null;
		specificity: number;
	}> = [
		{ geographyType: "grid10", geographyKey: options.geo.grid, specificity: 3 },
		{
			geographyType: "external_city",
			geographyKey: options.geo.city,
			specificity: 2,
		},
		{
			geographyType: "region",
			geographyKey: options.geo.region,
			specificity: 1,
		},
	];
	let best: { model: StoredSeriesModel; score: number } | null = null;
	for (const priority of priorities) {
		if (!priority.geographyKey) continue;
		const candidates = artifact.models.filter(
			(model) =>
				model.target === options.target &&
				model.segment === options.segment &&
				model.geographyType === priority.geographyType &&
				model.geographyKey === priority.geographyKey,
		);
		for (const model of candidates) {
			// Quality first, specificity second: a high-quality regional model
			// beats a noisy one-cell grid model, but a solid local estimate wins.
			const score = qualityRank(model.quality) * 100 + priority.specificity;
			if (!best || score > best.score) best = { model, score };
		}
	}
	return best?.model ?? null;
}

function priorPath(input: {
	frequency: "month" | "quarter";
	growth: number;
	volatility: number;
	horizon: number;
}): MarketPath {
	const perYear = PERIODS_PER_YEAR[input.frequency];
	const now = new Date();
	const currentOrdinal =
		input.frequency === "month"
			? now.getUTCFullYear() * 12 + now.getUTCMonth()
			: now.getUTCFullYear() * 4 + Math.floor(now.getUTCMonth() / 3);
	const mu = Math.log1p(input.growth) / perYear;
	const steps = Array.from({ length: input.horizon }, (_, index) => {
		const h = index + 1;
		const center = h * mu;
		const sd = input.volatility * Math.sqrt(h / perYear);
		return {
			period: periodFromOrdinal(currentOrdinal + h, input.frequency),
			mean: Math.exp(center),
			p10: Math.exp(center - Z80 * sd),
			p90: Math.exp(center + Z80 * sd),
		};
	});
	return { latestValue: 1, frequency: input.frequency, steps };
}

function modelPath(model: StoredSeriesModel): MarketPath {
	return {
		latestValue: model.latestValue,
		frequency: model.frequency,
		steps: model.steps,
	};
}

function evidenceOf(
	model: StoredSeriesModel | null,
): ForecastEvidenceDto | null {
	if (!model) return null;
	return {
		target: model.target,
		geographyType: model.geographyType,
		geographyKey: model.geographyKey,
		segment: model.segment,
		method: model.method,
		quality: model.quality,
		observations: model.observations,
		latestSample: model.latestSample,
		maePct: model.backtest?.maePct ?? null,
		coverage80: model.backtest?.coverage80 ?? null,
		coverage80OneYear: model.backtest?.coverage80OneYear ?? null,
		prior: model.method === "prior",
	};
}

function percentBand(band: {
	p10: number;
	p50: number;
	p90: number;
	mean: number;
}): ForecastBandDto {
	const round = (value: number) => Math.round(value * 10) / 10;
	return {
		p10: round(band.p10 * 100),
		p50: round(band.p50 * 100),
		p90: round(band.p90 * 100),
		mean: round(band.mean * 100),
	};
}

function mapStrategy(simulation: StrategySimulation): StrategyForecastDto {
	return {
		simulations: simulation.simulations,
		initialOutlay: Math.round(simulation.initialOutlay),
		year1NetIncome: Math.round(simulation.year1NetIncome),
		horizons: simulation.horizons.map((horizon) => ({
			years: horizon.years,
			irr: horizon.irr ? percentBand(horizon.irr) : null,
			totalReturnPct: percentBand(horizon.totalReturn),
			probabilityLossPct: Math.round(horizon.probabilityLossPct * 10) / 10,
			expectedShortfallIrrPct:
				horizon.expectedShortfallIrrPct == null
					? null
					: Math.round(horizon.expectedShortfallIrrPct * 10) / 10,
			annualNetIncomeYear1: Math.round(horizon.annualNetIncomeYear1),
		})),
	};
}

function appreciationHorizons(
	path: MarketPath,
): OfferForecastDto["appreciation"] {
	return YEARS.map((years) => {
		const point = pathPointAt(path, years * 12);
		return {
			years,
			meanPct: Math.round((Math.exp(point.meanLog) - 1) * 1000) / 10,
			p10Pct: Math.round((Math.exp(point.p10Log) - 1) * 1000) / 10,
			p90Pct: Math.round((Math.exp(point.p90Log) - 1) * 1000) / 10,
		};
	});
}

export interface OfferForecastInput {
	offerId: number;
	segment: "flat" | "house" | "plot";
	lat: number | null;
	lng: number | null;
	/** Purchase price, or the estimated purchase price for a rental. */
	buyPrice: number | null;
	/** Current fair value; defaults to buyPrice. */
	currentValue: number | null;
	/** Net annual long-term rent after czynsz and vacancy. */
	ltNetYearly: number | null;
	/** Gross annual short-term revenue before platform/cleaning costs. */
	strGrossYearly: number | null;
}

export async function buildOfferForecast(
	input: OfferForecastInput,
): Promise<OfferForecastDto> {
	const artifact = await loadArtifact();
	const geo = geoContext(input.lat, input.lng);
	const priceModel = pickModel(artifact, {
		target: "price",
		segment: input.segment,
		geo,
	});
	const rentModel = pickModel(artifact, {
		target: "rent",
		segment: "all",
		geo,
	});
	const strModel = pickModel(artifact, {
		target: "str",
		segment: "all",
		geo,
	});
	const pricePath =
		priceModel != null
			? modelPath(priceModel)
			: priorPath({
					frequency: "quarter",
					growth: 0.035,
					volatility: 0.1,
					horizon: 20,
				});
	const rentPath =
		rentModel != null
			? modelPath(rentModel)
			: priorPath({
					frequency: "month",
					growth: 0.035,
					volatility: 0.06,
					horizon: 60,
				});
	const strPath =
		strModel != null
			? modelPath(strModel)
			: priorPath({
					frequency: "month",
					growth: 0.02,
					volatility: 0.18,
					horizon: 60,
				});

	const correlations = geo.region
		? artifact?.correlations[geo.region]
		: undefined;
	const buyPrice = input.buyPrice ?? 0;
	const currentValue = input.currentValue ?? buyPrice;
	const canInvest = buyPrice > 0 && currentValue > 0;
	const simulationBase = {
		seed: input.offerId * 104729,
		simulations: SIMULATIONS,
		years: YEARS,
		buyPrice,
		currentValue,
		acquisitionCostPct: ACQUISITION_COST_PCT,
		sellingCostPct: SELLING_COST_PCT,
	};
	const ltr =
		canInvest && input.ltNetYearly != null && input.ltNetYearly > 0
			? simulateInvestment({
					...simulationBase,
					year1NetIncome: input.ltNetYearly,
					pricePath,
					incomePath: rentPath,
					correlation: correlations?.priceRent ?? 0.45,
				})
			: null;
	const strNetYearly =
		input.strGrossYearly == null
			? null
			: input.strGrossYearly * (1 - STR_EXPENSE_RATIO);
	const str =
		canInvest && strNetYearly != null && strNetYearly > 0
			? simulateInvestment({
					...simulationBase,
					year1NetIncome: strNetYearly,
					pricePath,
					incomePath: strPath,
					correlation: correlations?.priceStr ?? 0.3,
				})
			: null;

	const notes: string[] = [];
	if (!artifact) {
		notes.push(
			"Brak artefaktu prognoz (uruchom `bun run build:forecasts`); użyto jawnych priorów.",
		);
	}
	if (!priceModel) {
		notes.push(
			`Brak modelu cen dla segmentu ${input.segment}; przyjęto prior 3.5%/rok i σ 10%.`,
		);
	}
	if (!rentModel || rentModel.method === "prior") {
		notes.push(
			"Brak historii czynszów dla tej okolicy; prognoza najmu oparta na priorze, nie na lokalnym panelu.",
		);
	}
	if (
		!strModel ||
		strModel.method === "prior" ||
		(strModel.latestSample ?? 0) < 10
	) {
		notes.push(
			"Kalendarze STR są nieliczne lub krótkie; przedział dla najmu krótkoterminowego jest szeroki.",
		);
	}
	if (
		priceModel?.backtest?.coverage80 != null &&
		priceModel.backtest.coverage80 < 0.6
	) {
		notes.push(
			`Backtest cen pokrywa tylko ${(priceModel.backtest.coverage80 * 100).toFixed(0)}% interwału 80%; jakość obniżona.`,
		);
	}
	notes.push(
		"IRR bez dźwigni, po 3% kosztów zakupu i 2% kosztów sprzedaży; podatki i remonty poza modelem.",
	);

	return {
		generatedAt: artifact?.generatedAt ?? null,
		quality: {
			price: priceModel?.quality ?? "low",
			rent: rentModel?.quality ?? "low",
			str: strModel?.quality ?? "low",
		},
		evidence: {
			price: evidenceOf(priceModel),
			rent: evidenceOf(rentModel),
			str: evidenceOf(strModel),
		},
		appreciation: appreciationHorizons(pricePath),
		strategies: {
			ltr: ltr ? mapStrategy(ltr) : null,
			str: str ? mapStrategy(str) : null,
		},
		assumptions: {
			modelVersion: artifact?.version ?? 0,
			years: YEARS,
			simulations: SIMULATIONS,
			acquisitionCostPct: ACQUISITION_COST_PCT * 100,
			sellingCostPct: SELLING_COST_PCT * 100,
			strExpenseRatioPct: STR_EXPENSE_RATIO * 100,
			financing: "unlevered",
		},
		notes,
	};
}
