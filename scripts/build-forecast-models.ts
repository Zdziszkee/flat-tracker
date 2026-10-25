/**
 * Build the market forecast artifact used by /api/valuation/offer.
 *
 *   bun run build:forecasts
 *
 * Price models use the RCN/finwire index history directly. Rent and STR
 * models use the accumulating `history` panel inside the artifact: every run
 * appends the current observations, so a fresh database starts with explicit
 * priors and gradually earns the right to call itself estimated.
 */

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { priceIndexSeries } from "#/db/queries/price-indices";
import { regionOf } from "#/db/region";
import {
	FORECAST_ARTIFACT_PATH,
	FORECAST_ARTIFACT_VERSION,
	type ForecastArtifact,
	type ForecastGeography,
	type MarketSnapshot,
	type StoredCorrelation,
	type StoredSeriesModel,
} from "#/lib/forecast/artifact";
import { estimateCorrelation, type MarketTarget } from "#/lib/forecast/joint";
import {
	forecastUnivariate,
	type SeriesObservation,
} from "#/lib/forecast/univariate";
import { median } from "#/lib/forecast/core";
import { readJsonFile, writeJsonFile } from "#/lib/json-state";
import { EXTERNAL_CITIES } from "#/lib/valuation/external-city";

const HORIZON_QUARTERS = 20;
const HORIZON_MONTHS = 60;
const MAX_HISTORY_MONTHS = 120;

interface GeoRow {
	lat: number | null;
	lng: number | null;
}

function geographies(row: GeoRow): Array<{
	geographyType: ForecastGeography;
	geographyKey: string;
}> {
	if (row.lat == null || row.lng == null) return [];
	const region = regionOf(row.lat, row.lng);
	if (!region) return [];
	const out: Array<{
		geographyType: ForecastGeography;
		geographyKey: string;
	}> = [{ geographyType: "region", geographyKey: region }];
	// Only genuinely urban rows feed a city panel. externalCityFor's broad
	// regional proxy is right for a price-index fallback but would wrongly
	// label every small town in the voivodeship as Kraków/Katowice rent data.
	let best: { slug: string; distance: number } | null = null;
	for (const city of EXTERNAL_CITIES) {
		const distance = Math.hypot(
			(row.lat - city.lat) * 111,
			(row.lng - city.lng) * 111 * Math.cos((row.lat * Math.PI) / 180),
		);
		if (!best || distance < best.distance) best = { slug: city.slug, distance };
	}
	if (best && best.distance <= 35) {
		out.push({ geographyType: "external_city", geographyKey: best.slug });
	}
	return out;
}

function snapshotKey(snapshot: MarketSnapshot): string {
	return [
		snapshot.target,
		snapshot.geographyType,
		snapshot.geographyKey,
		snapshot.segment,
		snapshot.period,
	].join(":");
}

function seriesKey(snapshot: MarketSnapshot): string {
	return [
		snapshot.target,
		snapshot.geographyType,
		snapshot.geographyKey,
		snapshot.segment,
	].join(":");
}

function currentMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

async function buildPriceModels(): Promise<StoredSeriesModel[]> {
	const keys = await db.all<{
		segment: string;
		geographyType: ForecastGeography;
		geographyKey: string;
		n: number;
	}>(sql`
		SELECT segment, geography_type AS geographyType, geography_key AS geographyKey,
		       count(*) AS n
		FROM price_indices
		GROUP BY segment, geography_type, geography_key
	`);
	const models: StoredSeriesModel[] = [];
	for (const key of keys) {
		if (key.n < 4) continue;
		if (!["region", "grid10", "external_city"].includes(key.geographyType)) {
			continue;
		}
		const points = await priceIndexSeries({
			segment: key.segment as "flat",
			geographyType: key.geographyType,
			geographyKey: key.geographyKey,
		});
		const observations: SeriesObservation[] = points.map((point) => ({
			period: point.period,
			value: point.indexValue,
			weight: point.sampleCount,
		}));
		const forecast = forecastUnivariate(observations, {
			frequency: "quarter",
			horizon: HORIZON_QUARTERS,
			longRunAnnualGrowth: 0.035,
			annualVolatility: 0.06,
			seasonal: false,
		});
		models.push({
			...forecast,
			target: "price",
			geographyType: key.geographyType,
			geographyKey: key.geographyKey,
			segment: key.segment,
			frequency: "quarter",
			scale: "log",
			observations: observations.length,
			latestSample: points[points.length - 1]?.sampleCount ?? null,
		});
	}
	return models;
}

async function rentSnapshots(): Promise<MarketSnapshot[]> {
	const rows = await db.all<
		GeoRow & { price: number; areaM2: number }
	>(sql`
		SELECT price, areaM2, lat, lng
		FROM listings
		WHERE offer_type = 'long_term_rental'
		  AND price > 0
		  AND areaM2 BETWEEN 10 AND 250
		  AND price / areaM2 BETWEEN 10 AND 200
		  AND lat IS NOT NULL AND lng IS NOT NULL
	`);
	const groups = new Map<string, { values: number[]; base: MarketSnapshot }>();
	for (const row of rows) {
		const rentM2 = row.price / row.areaM2;
		for (const geo of geographies(row)) {
			const base: MarketSnapshot = {
				target: "rent",
				geographyType: geo.geographyType,
				geographyKey: geo.geographyKey,
				segment: "all",
				period: currentMonth(),
				capturedAt: currentMonth(),
				value: rentM2,
				samples: 1,
			};
			const key = snapshotKey(base);
			const group = groups.get(key) ?? { values: [], base };
			group.values.push(rentM2);
			groups.set(key, group);
		}
	}
	return [...groups.values()]
		.filter((group) => group.values.length >= 3)
		.map((group) => ({
			...group.base,
			value: median(group.values) ?? 0,
			samples: group.values.length,
		}))
		.filter((snapshot) => snapshot.value > 0);
}

async function strSnapshots(): Promise<MarketSnapshot[]> {
	const rows = await db.all<
		GeoRow & {
			month: string;
			capturedAt: string;
			adr: number | null;
			occupancy: number | null;
			booked: number | null;
			sample: number | null;
		}
	>(sql`
		SELECT o.month, strftime('%Y-%m', o.captured_at, 'unixepoch') AS capturedAt,
		       o.avg_available_price AS adr, o.occupancy_rate AS occupancy,
		       o.booked_nights AS booked, o.sample_days AS sample, l.lat, l.lng
		FROM listing_occupancy o
		JOIN listings l ON l.id = o.listing_id
		WHERE o.occupancy_rate IS NOT NULL
		  AND o.avg_available_price > 0
		  AND o.sample_days > 0
		  AND l.lat IS NOT NULL AND l.lng IS NOT NULL
	`);
	const groups = new Map<
		string,
		{
			adr: number[];
			booked: number;
			sample: number;
			base: MarketSnapshot;
			capturedAt: string;
		}
	>();
	for (const row of rows) {
		if (row.adr == null || row.occupancy == null) continue;
		for (const geo of geographies(row)) {
			const base: MarketSnapshot = {
				target: "str",
				geographyType: geo.geographyType,
				geographyKey: geo.geographyKey,
				segment: "all",
				period: row.month,
				capturedAt: row.capturedAt,
				value: 0,
				samples: 1,
			};
			const key = snapshotKey(base);
			let group = groups.get(key) ?? {
				adr: [],
				booked: 0,
				sample: 0,
				base,
				capturedAt: row.capturedAt,
			};
			// A later crawl of the same future month supersedes the earlier
			// one instead of double-counting the same calendar nights.
			if (row.capturedAt > group.capturedAt) {
				group = {
					adr: [],
					booked: 0,
					sample: 0,
					base,
					capturedAt: row.capturedAt,
				};
			}
			group.adr.push(row.adr);
			group.booked += row.booked ?? 0;
			group.sample += row.sample ?? 0;
			groups.set(key, group);
		}
	}
	return [...groups.values()]
		.map((group) => {
			const adr = median(group.adr) ?? 0;
			const occupancy = group.sample > 0 ? group.booked / group.sample : 0;
			return {
				...group.base,
				// RevPAN: monthly ADR x occupancy, the STR revenue driver.
				value: adr * occupancy,
				samples: group.adr.length,
			};
		})
		.filter((snapshot) => snapshot.value > 0);
}

function mergeHistory(
	previous: readonly MarketSnapshot[],
	fresh: readonly MarketSnapshot[],
): MarketSnapshot[] {
	const byKey = new Map<string, MarketSnapshot>();
	for (const snapshot of previous) byKey.set(snapshotKey(snapshot), snapshot);
	for (const snapshot of fresh) byKey.set(snapshotKey(snapshot), snapshot);
	const bySeries = new Map<string, MarketSnapshot[]>();
	for (const snapshot of byKey.values()) {
		const key = seriesKey(snapshot);
		const list = bySeries.get(key) ?? [];
		list.push(snapshot);
		bySeries.set(key, list);
	}
	return [...bySeries.values()].flatMap((snapshots) =>
		snapshots
			.sort((a, b) => a.period.localeCompare(b.period))
			.slice(-MAX_HISTORY_MONTHS),
	);
}

function buildPanelModels(
	history: readonly MarketSnapshot[],
): StoredSeriesModel[] {
	const bySeries = new Map<string, MarketSnapshot[]>();
	for (const snapshot of history) {
		const key = seriesKey(snapshot);
		const list = bySeries.get(key) ?? [];
		list.push(snapshot);
		bySeries.set(key, list);
	}
	const models: StoredSeriesModel[] = [];
	for (const snapshots of bySeries.values()) {
		const sorted = [...snapshots].sort((a, b) =>
			a.period.localeCompare(b.period),
		);
		const first = sorted[0];
		if (!first) continue;
		const target = first.target;
		const captures = new Set(
			sorted.map((snapshot) => snapshot.capturedAt ?? snapshot.period),
		);
		// STR calendar rows are future months, not a time series. Until there
		// are at least eight distinct capture months, collapse the current
		// curve to one level observation and forecast it with an explicit
		// prior. Otherwise the model would mistake Sep-2026..Aug-2027 for
		// twelve months of realized growth.
		const useCurrentLevel = target === "str" && captures.size < 8;
		let observations: Array<{
			period: string;
			value: number;
			weight: number;
		}>;
		let latestSample: number | null;
		if (useCurrentLevel) {
			const newestCapture = [...captures].sort().at(-1) ?? first.period;
			const latest = sorted.filter(
				(snapshot) =>
					(snapshot.capturedAt ?? snapshot.period) === newestCapture,
			);
			const totalWeight = latest.reduce(
				(sum, snapshot) => sum + snapshot.samples,
				0,
			);
			const level =
				totalWeight > 0
					? latest.reduce(
							(sum, snapshot) => sum + snapshot.value * snapshot.samples,
							0,
						) / totalWeight
					: (latest[0]?.value ?? first.value);
			observations = [
				{ period: newestCapture, value: level, weight: totalWeight },
			];
			latestSample = totalWeight;
		} else {
			observations = sorted.map((snapshot) => ({
				period: snapshot.period,
				value: snapshot.value,
				weight: snapshot.samples,
			}));
			latestSample = sorted[sorted.length - 1]?.samples ?? null;
		}
		const forecast = forecastUnivariate(observations, {
			frequency: "month",
			horizon: HORIZON_MONTHS,
			longRunAnnualGrowth: target === "rent" ? 0.035 : 0.02,
			annualVolatility: target === "rent" ? 0.06 : 0.18,
		});
		models.push({
			...forecast,
			target,
			geographyType: first.geographyType,
			geographyKey: first.geographyKey,
			segment: first.segment,
			frequency: "month",
			scale: "log",
			observations: observations.length,
			latestSample,
		});
	}
	return models;
}

function correlationFor(
	models: readonly StoredSeriesModel[],
	geographyKey: string,
): StoredCorrelation {
	const find = (target: MarketTarget) =>
		models.find(
			(model) =>
				model.target === target &&
				model.geographyType === "region" &&
				model.geographyKey === geographyKey &&
				(model.segment === "flat" || model.segment === "all"),
		);
	const price = find("price");
	const rent = find("rent");
	const str = find("str");
	return {
		geographyKey,
		priceRent: estimateCorrelation(
			price?.residuals ?? [],
			rent?.residuals ?? [],
			"price",
			"rent",
		).r,
		priceStr: estimateCorrelation(
			price?.residuals ?? [],
			str?.residuals ?? [],
			"price",
			"str",
		).r,
		rentStr: estimateCorrelation(
			rent?.residuals ?? [],
			str?.residuals ?? [],
			"rent",
			"str",
		).r,
	};
}

const previous = await readJsonFile<ForecastArtifact>(FORECAST_ARTIFACT_PATH);
console.log("Building price models from RCN/finwire indices...");
const priceModels = await buildPriceModels();
console.log(`  ${priceModels.length} price series`);
const fresh = [...(await rentSnapshots()), ...(await strSnapshots())];
console.log(
	`  ${fresh.length} fresh rent/STR observations ` +
		`(${fresh.filter((s) => s.target === "rent").length} rent, ` +
		`${fresh.filter((s) => s.target === "str").length} STR)`,
);
const history = mergeHistory(previous?.history ?? [], fresh);
const panelModels = buildPanelModels(history);
const models = [...priceModels, ...panelModels];
const regions = [
	...new Set(
		models
			.filter((model) => model.geographyType === "region")
			.map((model) => model.geographyKey),
	),
];
const correlations = Object.fromEntries(
	regions.map((region) => [region, correlationFor(models, region)]),
);
const artifact: ForecastArtifact = {
	version: FORECAST_ARTIFACT_VERSION,
	generatedAt: new Date().toISOString(),
	models,
	history,
	correlations,
};
await writeJsonFile(FORECAST_ARTIFACT_PATH, artifact);
const summary = {
	models: models.length,
	priceModels: priceModels.length,
	rentModels: panelModels.filter((model) => model.target === "rent").length,
	strModels: panelModels.filter((model) => model.target === "str").length,
	estimated: models.filter((model) => model.method !== "prior").length,
	priors: models.filter((model) => model.method === "prior").length,
	historyRows: history.length,
	output: FORECAST_ARTIFACT_PATH,
};
console.log(JSON.stringify(summary, null, 2));
const examples = models
	.filter((model) => model.target !== "price" || model.geographyType === "region")
	.slice(0, 8)
	.map((model) => ({
		key: `${model.target}:${model.geographyType}:${model.geographyKey}:${model.segment}`,
		method: model.method,
		quality: model.quality,
		observations: model.observations,
		maePct: model.backtest?.maePct,
		coverage80: model.backtest?.coverage80,
	}));
console.log(JSON.stringify(examples, null, 2));
