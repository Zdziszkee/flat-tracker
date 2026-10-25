/**
 * Univariate market forecasting with walk-forward model selection and
 * calibrated predictive intervals.
 *
 * The forecaster deliberately stays small: a damped AR(1) trend in
 * transformed space, with an optional seasonal component. Two candidates are
 * compared by rolling-origin backtests, and the interval is built from the
 * selected model's own out-of-sample errors (recency-weighted conformal-style
 * calibration), not from an assumed variance. Sparse series fall back to an
 * explicit prior and are marked low quality instead of pretending to be
 * estimated.
 */

import {
	clamp,
	expit,
	type ForecastFrequency,
	logit,
	mean,
	PERIODS_PER_YEAR,
	periodFromOrdinal,
	periodOrdinal,
	quantile,
	standardDeviation,
	weightedQuantile,
	Z80,
} from "./core";

export type SeriesScale = "log" | "logit" | "level";
export type ForecastQuality = "high" | "medium" | "low";

export interface SeriesObservation {
	period: string;
	value: number;
	weight?: number;
}

export interface SeriesResidual {
	t: number;
	value: number;
}

export interface ForecastStep {
	period: string;
	mean: number;
	p10: number;
	p90: number;
}

export interface BacktestSummary {
	method: string;
	errors: number;
	/** Mean absolute error in transformed space. */
	mae: number;
	/** Mean absolute percentage error; only defined for log scale. */
	maePct: number | null;
	/** Held-out coverage of the central 80% interval, if measurable. */
	coverage80: number | null;
	/** Held-out coverage at the one-year horizon, if measurable. */
	coverage80OneYear: number | null;
}

export interface SeriesForecast {
	latestPeriod: string;
	latestValue: number;
	steps: ForecastStep[];
	/** Out-of-sample one-step residuals, used for cross-market correlation. */
	residuals: SeriesResidual[];
	backtest: BacktestSummary | null;
	method: string;
	quality: ForecastQuality;
}

export interface UnivariateOptions {
	frequency: ForecastFrequency;
	horizon: number;
	scale?: SeriesScale;
	/** Long-run annual drift used for shrinkage and for the sparse prior. */
	longRunAnnualGrowth?: number;
	/** Annualized prior volatility for sparse series. */
	annualVolatility?: number;
	/** Starting level when there are no observations. */
	priorLevel?: number;
	/** Seasonal candidate; defaults to true for monthly series. */
	seasonal?: boolean;
}

interface Point {
	t: number;
	y: number;
}

interface Candidate {
	name: string;
	seasonal: number[];
	seasonalPeriod: number;
	mu: number;
	phi: number;
	lastT: number;
	lastZ: number;
	lastDiff: number;
}

const RECENT_WEIGHT = 0.35;
const MIN_TRAIN = 6;
const MAX_PHI = 0.6;

function transform(value: number, scale: SeriesScale): number {
	if (scale === "log") return Math.log(Math.max(value, 1e-9));
	if (scale === "logit") return logit(value);
	return value;
}

function inverse(value: number, scale: SeriesScale): number {
	if (scale === "log") return Math.exp(value);
	if (scale === "logit") return expit(value);
	return value;
}

function toPoints(
	observations: readonly SeriesObservation[],
	scale: SeriesScale,
): Point[] {
	const byTime = new Map<number, number>();
	for (const observation of observations) {
		const t = periodOrdinal(observation.period);
		if (t == null || !Number.isFinite(observation.value)) continue;
		if (scale === "log" && observation.value <= 0) continue;
		if (
			scale === "logit" &&
			(observation.value <= 0 || observation.value >= 1)
		) {
			continue;
		}
		byTime.set(t, transform(observation.value, scale));
	}
	return [...byTime.entries()]
		.map(([t, y]) => ({ t, y }))
		.sort((a, b) => a.t - b.t);
}

function differences(points: readonly Point[]): number[] {
	const out: number[] = [];
	for (let i = 1; i < points.length; i++) {
		const previous = points[i - 1];
		const current = points[i];
		if (!previous || !current) continue;
		const gap = current.t - previous.t;
		if (gap > 0) out.push((current.y - previous.y) / gap);
	}
	return out;
}

/** Cumulative transitory AR(1) deviation after h steps. */
function transitorySum(phi: number, x0: number, h: number): number {
	if (phi <= 1e-6 || h <= 0) return 0;
	return x0 * ((phi * (1 - phi ** h)) / (1 - phi));
}

function ar1Phi(diffs: readonly number[]): number {
	if (diffs.length < 8) return 0;
	const lag = diffs.slice(0, -1);
	const current = diffs.slice(1);
	const meanLag = mean(lag) ?? 0;
	const meanCurrent = mean(current) ?? 0;
	let covariance = 0;
	let variance = 0;
	for (let i = 0; i < lag.length; i++) {
		covariance += ((lag[i] ?? 0) - meanLag) * ((current[i] ?? 0) - meanCurrent);
		variance += ((lag[i] ?? 0) - meanLag) ** 2;
	}
	return variance > 0 ? clamp(covariance / variance, 0, MAX_PHI) : 0;
}

/**
 * Additive seasonal component in transformed space, estimated on a moving
 * average detrended series and shrunk toward zero for thin seasons.
 */
function seasonalComponent(
	points: readonly Point[],
	period: number,
): number[] | null {
	if (period <= 1 || points.length < period * 2) return null;
	const bySeason = Array.from({ length: period }, () => [] as number[]);
	for (let i = 0; i < points.length; i++) {
		const point = points[i];
		if (!point) continue;
		const start = Math.max(0, i - Math.floor(period / 2));
		const end = Math.min(points.length - 1, i + Math.ceil(period / 2) - 1);
		let sum = 0;
		let count = 0;
		for (let j = start; j <= end; j++) {
			sum += points[j]?.y ?? 0;
			count++;
		}
		if (count === 0) continue;
		const season = ((point.t % period) + period) % period;
		bySeason[season]?.push(point.y - sum / count);
	}
	const seasonal = bySeason.map((values) => {
		const avg = mean(values) ?? 0;
		const shrink = values.length / (values.length + 2);
		return avg * shrink;
	});
	const center = mean(seasonal) ?? 0;
	return seasonal.map((value) => value - center);
}

function fitCandidate(
	points: readonly Point[],
	seasonalPeriod: number,
	longRunMu: number,
): Candidate {
	const seasonal =
		seasonalPeriod > 1 ? seasonalComponent(points, seasonalPeriod) : null;
	const component = seasonal ?? Array(Math.max(1, seasonalPeriod)).fill(0);
	const period = seasonal ? seasonalPeriod : 1;
	const z = points.map((point) => ({
		t: point.t,
		y: point.y - (component[((point.t % period) + period) % period] ?? 0),
	}));
	const diffs = differences(z);
	const recent = diffs.slice(-8);
	const recentMean = mean(recent) ?? longRunMu;
	const mu = RECENT_WEIGHT * recentMean + (1 - RECENT_WEIGHT) * longRunMu;
	const last = z[z.length - 1];
	return {
		name: seasonal ? "seasonal-ar1" : "ar1",
		seasonal: component,
		seasonalPeriod: period,
		mu,
		phi: ar1Phi(diffs),
		lastT: last?.t ?? 0,
		lastZ: last?.y ?? 0,
		lastDiff: diffs[diffs.length - 1] ?? mu,
	};
}

function predict(candidate: Candidate, targetT: number): number {
	const h = Math.max(0, targetT - candidate.lastT);
	const seasonal =
		candidate.seasonal[
			((targetT % candidate.seasonalPeriod) + candidate.seasonalPeriod) %
				candidate.seasonalPeriod
		] ?? 0;
	return (
		candidate.lastZ +
		h * candidate.mu +
		transitorySum(candidate.phi, candidate.lastDiff - candidate.mu, h) +
		seasonal
	);
}

interface BacktestError {
	cut: number;
	t: number;
	h: number;
	error: number;
	prediction: number;
	actual: number;
}

interface BacktestResult {
	candidate: Candidate;
	errors: BacktestError[];
	score: number;
	mae: number;
	maePct: number | null;
}

function runBacktest(
	points: readonly Point[],
	candidates: Array<{ period: number }>,
	longRunMu: number,
	scale: SeriesScale,
	horizon: number,
): BacktestResult[] {
	const results: BacktestResult[] = [];
	for (const spec of candidates) {
		const minTrain = Math.max(MIN_TRAIN, spec.period > 1 ? spec.period * 2 : 0);
		if (points.length <= minTrain + 1) continue;
		const errors: BacktestError[] = [];
		for (let cut = minTrain; cut < points.length - 1; cut++) {
			const train = points.slice(0, cut);
			const candidate = fitCandidate(train, spec.period, longRunMu);
			for (let j = cut; j < points.length; j++) {
				const target = points[j];
				if (!target) continue;
				const h = target.t - (points[cut - 1]?.t ?? target.t);
				if (h <= 0 || h > horizon) continue;
				const prediction = predict(candidate, target.t);
				errors.push({
					cut,
					t: target.t,
					h,
					error: target.y - prediction,
					prediction,
					actual: target.y,
				});
			}
		}
		if (errors.length === 0) continue;
		const mae = mean(errors.map((error) => Math.abs(error.error))) ?? 0;
		const maePct =
			scale === "log"
				? mean(errors.map((error) => Math.abs(Math.exp(error.error) - 1)))
				: null;
		results.push({
			candidate: fitCandidate(points, spec.period, longRunMu),
			errors,
			score: mae,
			mae,
			maePct,
		});
	}
	return results.sort((a, b) => a.score - b.score);
}

function calibratedQuantiles(
	errors: readonly BacktestError[],
	horizon: number,
	fallbackSigma: number,
): { q10: number; q90: number } {
	// Errors are pooled after scaling by sqrt(h). A single horizon has only a
	// handful of rolling origins, which made the old per-horizon quantiles
	// unstable and often wildly too wide or too narrow. Scaling preserves the
	// horizon-dependent bias and variance while giving the quantiles a real
	// sample to work with.
	const maxCut = Math.max(...errors.map((error) => error.cut));
	const pooled = errors.map((error) => ({
		value: error.error / Math.sqrt(error.h),
		weight: 0.5 ** ((maxCut - error.cut) / 8),
	}));
	if (pooled.length >= 12) {
		const bias = weightedQuantile(pooled, 0.5) ?? 0;
		const deviations = pooled.map((entry) => ({
			value: Math.abs(entry.value - bias),
			weight: entry.weight,
		}));
		// Central 80% needs a radius, but a purely recency-weighted 80th
		// percentile was too confident in trend accelerations. Keep the larger
		// of the recent 80% radius and the full-sample 90% radius, then add a
		// small safety margin. Calibration that fails during a break is worse
		// than calibration that is merely wide.
		const recentRadius = weightedQuantile(deviations, 0.8) ?? 0;
		const fullRadius =
			weightedQuantile(
				deviations.map((entry) => ({ value: entry.value, weight: 1 })),
				0.9,
			) ?? recentRadius;
		const radius = Math.max(recentRadius, fullRadius) * 1.1;
		if (radius > 0) {
			const scale = Math.sqrt(Math.max(1, horizon));
			return {
				q10: (bias - radius) * scale,
				q90: (bias + radius) * scale,
			};
		}
	}
	const atHorizon = errors.filter((error) => error.h === horizon);
	if (atHorizon.length >= 5) {
		const weighted = atHorizon.map((error) => ({
			value: error.error,
			weight: 0.5 ** ((maxCut - error.cut) / 8),
		}));
		const q10 = weightedQuantile(weighted, 0.1);
		const q90 = weightedQuantile(weighted, 0.9);
		if (q10 != null && q90 != null) return { q10, q90 };
	}
	const sigma =
		standardDeviation(atHorizon.map((error) => error.error)) ??
		fallbackSigma * Math.sqrt(Math.max(1, horizon));
	return { q10: -Z80 * sigma, q90: Z80 * sigma };
}

function heldOutCoverage(
	errors: readonly BacktestError[],
	onlyHorizon?: number,
): number | null {
	const usable =
		onlyHorizon == null
			? errors
			: errors.filter((error) => error.h === onlyHorizon);
	if (usable.length < 12) return null;
	const cuts = [...new Set(usable.map((error) => error.cut))].sort(
		(a, b) => a - b,
	);
	const split = cuts[Math.floor(cuts.length * 0.7)];
	if (split == null) return null;
	const calibration = errors.filter((error) => error.cut < split);
	const heldOut = usable.filter((error) => error.cut >= split);
	let covered = 0;
	let total = 0;
	for (const error of heldOut) {
		const { q10, q90 } = calibratedQuantiles(calibration, error.h, 0.05);
		if (
			error.actual >= error.prediction + q10 &&
			error.actual <= error.prediction + q90
		) {
			covered++;
		}
		total++;
	}
	return total > 0 ? covered / total : null;
}

function priorForecast(
	options: UnivariateOptions,
	observations: readonly SeriesObservation[],
	scale: SeriesScale,
): SeriesForecast {
	const perYear = PERIODS_PER_YEAR[options.frequency];
	const points = toPoints(observations, scale);
	const latestPoint = points[points.length - 1];
	const latestValue =
		latestPoint != null
			? inverse(latestPoint.y, scale)
			: (options.priorLevel ?? 1);
	const latestY = latestPoint?.y ?? transform(latestValue, scale);
	const now = new Date();
	const currentPeriod =
		options.frequency === "month"
			? now.toISOString().slice(0, 7)
			: `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
	const startT = latestPoint?.t ?? periodOrdinal(currentPeriod) ?? 0;
	const mu =
		scale === "logit"
			? 0
			: Math.log1p(options.longRunAnnualGrowth ?? 0.035) / perYear;
	const sigmaAnnual = options.annualVolatility ?? 0.08;
	const steps: ForecastStep[] = [];
	for (let h = 1; h <= options.horizon; h++) {
		const t = startT + h;
		const center = latestY + h * mu;
		const sd = sigmaAnnual * Math.sqrt(h / perYear);
		steps.push({
			period: periodFromOrdinal(t, options.frequency),
			mean: inverse(center, scale),
			p10: inverse(center - Z80 * sd, scale),
			p90: inverse(center + Z80 * sd, scale),
		});
	}
	return {
		latestPeriod: periodFromOrdinal(startT, options.frequency),
		latestValue,
		steps,
		residuals: [],
		backtest: null,
		method: "prior",
		quality: "low",
	};
}

export function forecastUnivariate(
	observations: readonly SeriesObservation[],
	options: UnivariateOptions,
): SeriesForecast {
	const scale = options.scale ?? "log";
	const points = toPoints(observations, scale);
	const minPoints = Math.max(4, MIN_TRAIN + 2);
	if (points.length < minPoints) {
		return priorForecast(options, observations, scale);
	}
	const perYear = PERIODS_PER_YEAR[options.frequency];
	const longRunMu =
		scale === "logit"
			? 0
			: Math.log1p(options.longRunAnnualGrowth ?? 0.035) / perYear;
	const seasonalPeriod =
		(options.seasonal ?? options.frequency === "month") ? perYear : 1;
	const candidates = [
		{ period: 1 },
		...(seasonalPeriod > 1 ? [{ period: seasonalPeriod }] : []),
	];
	const backtests = runBacktest(
		points,
		candidates,
		longRunMu,
		scale,
		options.horizon,
	);
	const best = backtests[0];
	if (!best) return priorForecast(options, observations, scale);

	const candidate = best.candidate;
	const latest = points[points.length - 1];
	if (!latest) return priorForecast(options, observations, scale);
	const diffs = differences(points);
	const sigma = standardDeviation(diffs) ?? 0.02;
	const steps: ForecastStep[] = [];
	for (let h = 1; h <= options.horizon; h++) {
		const t = latest.t + h;
		const center = predict(candidate, t);
		const { q10, q90 } = calibratedQuantiles(best.errors, h, sigma);
		steps.push({
			period: periodFromOrdinal(t, options.frequency),
			mean: inverse(center, scale),
			p10: inverse(center + Math.min(q10, q90), scale),
			p90: inverse(center + Math.max(q10, q90), scale),
		});
	}
	const years = (latest.t - (points[0]?.t ?? latest.t)) / perYear;
	const coverage = heldOutCoverage(best.errors);
	const coverageOneYear = heldOutCoverage(best.errors, perYear);
	const wellCalibrated = coverage == null || coverage >= 0.6;
	const quality: ForecastQuality =
		years >= 4 && best.errors.length >= 20 && wellCalibrated
			? "high"
			: years >= 1.5
				? "medium"
				: "low";
	return {
		latestPeriod: periodFromOrdinal(latest.t, options.frequency),
		latestValue: inverse(latest.y, scale),
		steps,
		residuals: best.errors
			.filter((error) => error.h === 1)
			.map((error) => ({ t: error.t, value: error.error })),
		backtest: {
			method: candidate.name,
			errors: best.errors.length,
			mae: best.mae,
			maePct: best.maePct,
			coverage80: coverage,
			coverage80OneYear: coverageOneYear,
		},
		method: candidate.name,
		quality,
	};
}

/** Convenience for tests and for readers of the artifact. */
export function summarizeLevels(steps: readonly ForecastStep[]): {
	p10: number | null;
	p50: number | null;
	p90: number | null;
} {
	return {
		p10: quantile(
			steps.map((step) => step.p10),
			0.5,
		),
		p50: quantile(
			steps.map((step) => step.mean),
			0.5,
		),
		p90: quantile(
			steps.map((step) => step.p90),
			0.5,
		),
	};
}
