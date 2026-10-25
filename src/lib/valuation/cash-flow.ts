/**
 * Cash-flow based investment return simulation.
 *
 * Price and income are not independent inputs: each simulated path draws a
 * correlated market scenario, then applies it to every horizon. That keeps a
 * weak-price/weak-rent scenario coherent instead of averaging unrelated
 * percentiles. Returns are computed from actual cash flows (acquisition
 * costs, net operating income, exit value less selling costs), so IRR is not
 * confused with price appreciation.
 */

import {
	clamp,
	type ForecastFrequency,
	mean,
	mulberry32,
	normalDraw,
	PERIODS_PER_YEAR,
	quantile,
	Z80,
} from "#/lib/forecast/core";
import type { ForecastStep } from "#/lib/forecast/univariate";

export interface MarketPath {
	latestValue: number;
	frequency: ForecastFrequency;
	steps: ForecastStep[];
}

export interface Distribution {
	p10: number;
	p50: number;
	p90: number;
	mean: number;
}

export interface StrategyHorizon {
	years: number;
	irr: Distribution | null;
	totalReturn: Distribution;
	probabilityLossPct: number;
	/** Mean of the worst 10% of IRR outcomes. */
	expectedShortfallIrrPct: number | null;
	exitValue: Distribution;
	annualNetIncomeYear1: number;
}

export interface StrategySimulation {
	simulations: number;
	initialOutlay: number;
	year1NetIncome: number;
	horizons: StrategyHorizon[];
}

export interface SimulationInput {
	seed: number;
	simulations?: number;
	years?: number[];
	buyPrice: number;
	/** Current market value; differs from buyPrice for mispriced offers. */
	currentValue: number;
	year1NetIncome: number;
	pricePath: MarketPath;
	incomePath: MarketPath;
	correlation: number;
	acquisitionCostPct?: number;
	sellingCostPct?: number;
	capex?: number;
}

interface PathPoint {
	meanLog: number;
	sigmaLog: number;
	p10Log: number;
	p90Log: number;
}

function fallbackPoint(monthsAhead: number): PathPoint {
	const sigmaLog = 0.1 * Math.sqrt(monthsAhead / 12);
	return {
		meanLog: 0,
		sigmaLog,
		p10Log: -Z80 * sigmaLog,
		p90Log: Z80 * sigmaLog,
	};
}

/** Interpolated/extrapolated log multiplier and its scenario volatility. */
export function pathPointAt(path: MarketPath, monthsAhead: number): PathPoint {
	if (path.latestValue <= 0 || path.steps.length === 0) {
		return fallbackPoint(monthsAhead);
	}
	const stepMonths = 12 / PERIODS_PER_YEAR[path.frequency];
	const lastIndex = path.steps.length;
	const wanted = Math.max(1, Math.round(monthsAhead / stepMonths));
	const index = Math.min(wanted, lastIndex);
	const step = path.steps[index - 1];
	if (!step || !(step.mean > 0) || !(step.p10 > 0) || !(step.p90 > 0)) {
		return fallbackPoint(monthsAhead);
	}
	const coveredMonths = index * stepMonths;
	const extrapolation = coveredMonths > 0 ? monthsAhead / coveredMonths : 1;
	const meanLog = Math.log(step.mean / path.latestValue) * extrapolation;
	const spread =
		(Math.log(Math.max(step.p90, 1e-9) / path.latestValue) -
			Math.log(Math.max(step.p10, 1e-9) / path.latestValue)) /
		(2 * Z80);
	const sigmaLog =
		!Number.isFinite(spread) || spread < 0
			? fallbackPoint(monthsAhead).sigmaLog
			: spread === 0
				? 0
				: spread * Math.sqrt(Math.max(extrapolation, 1e-6));
	const clippedSigma = clamp(sigmaLog, 0, 2);
	const exactStep = Math.abs(extrapolation - 1) < 1e-9;
	return {
		meanLog,
		sigmaLog: clippedSigma,
		p10Log: exactStep
			? Math.log(step.p10 / path.latestValue)
			: meanLog - Z80 * clippedSigma,
		p90Log: exactStep
			? Math.log(step.p90 / path.latestValue)
			: meanLog + Z80 * clippedSigma,
	};
}

function distribution(values: readonly number[]): Distribution | null {
	if (values.length === 0) return null;
	return {
		p10: quantile(values, 0.1) ?? 0,
		p50: quantile(values, 0.5) ?? 0,
		p90: quantile(values, 0.9) ?? 0,
		mean: mean(values) ?? 0,
	};
}

/** Annual IRR of -initial at t=0 followed by yearly cash flows. */
export function irrAnnual(
	initialOutlay: number,
	cashFlows: readonly number[],
): number | null {
	if (!(initialOutlay > 0) || cashFlows.length === 0) return null;
	const npv = (rate: number): number => {
		let value = -initialOutlay;
		for (let i = 0; i < cashFlows.length; i++) {
			value += (cashFlows[i] ?? 0) / (1 + rate) ** (i + 1);
		}
		return value;
	};
	let low = -0.9999;
	let high = 10;
	let fLow = npv(low);
	const fHigh = npv(high);
	if (!Number.isFinite(fLow) || !Number.isFinite(fHigh)) return null;
	if (fLow * fHigh > 0) return null;
	for (let i = 0; i < 80; i++) {
		const mid = (low + high) / 2;
		const fMid = npv(mid);
		if (Math.abs(fMid) < 1e-7) return mid;
		if (fLow * fMid <= 0) {
			high = mid;
		} else {
			low = mid;
			fLow = fMid;
		}
	}
	return (low + high) / 2;
}

export function simulateInvestment(input: SimulationInput): StrategySimulation {
	const simulations = input.simulations ?? 400;
	const years = input.years ?? [1, 3, 5];
	const maxYear = Math.max(...years);
	const acquisitionCostPct = input.acquisitionCostPct ?? 0.03;
	const sellingCostPct = input.sellingCostPct ?? 0.02;
	const initialOutlay =
		input.buyPrice * (1 + acquisitionCostPct) + (input.capex ?? 0);
	const rho = clamp(input.correlation, -0.95, 0.95);
	const horizons = years.map((year) => ({
		years: year,
		irrValues: [] as number[],
		returnValues: [] as number[],
		losses: 0,
		exitValues: [] as number[],
	}));

	for (let simulation = 0; simulation < simulations; simulation++) {
		// Seeded per path: stable across requests and identical for the LTR and
		// STR strategy of the same offer, so the comparison is like-for-like.
		const rng = mulberry32(input.seed + simulation * 7919);
		const n1 = normalDraw(rng);
		const n2 = normalDraw(rng);
		const zPrice = n1;
		const zIncome = rho * n1 + Math.sqrt(1 - rho * rho) * n2;
		const netIncomeByYear: number[] = [];
		const priceMultiplierByYear: number[] = [];
		for (let year = 1; year <= maxYear; year++) {
			const incomePoint = pathPointAt(input.incomePath, year * 12);
			const pricePoint = pathPointAt(input.pricePath, year * 12);
			netIncomeByYear.push(
				input.year1NetIncome *
					Math.exp(incomePoint.meanLog + incomePoint.sigmaLog * zIncome),
			);
			priceMultiplierByYear.push(
				Math.exp(pricePoint.meanLog + pricePoint.sigmaLog * zPrice),
			);
		}
		for (const horizon of horizons) {
			const cashFlows = netIncomeByYear.slice(0, horizon.years);
			const exitValue =
				input.currentValue *
				(priceMultiplierByYear[horizon.years - 1] ?? 1) *
				(1 - sellingCostPct);
			cashFlows[horizon.years - 1] =
				(cashFlows[horizon.years - 1] ?? 0) + exitValue;
			const irr = irrAnnual(initialOutlay, cashFlows);
			if (irr != null && Number.isFinite(irr)) horizon.irrValues.push(irr);
			const totalReturn =
				(cashFlows.reduce((sum, value) => sum + value, 0) - initialOutlay) /
				initialOutlay;
			horizon.returnValues.push(totalReturn);
			if (totalReturn < 0) horizon.losses++;
			horizon.exitValues.push(exitValue);
		}
	}

	return {
		simulations,
		initialOutlay,
		year1NetIncome: input.year1NetIncome,
		horizons: horizons.map((horizon) => {
			const irrDist = distribution(horizon.irrValues);
			const sortedIrr = [...horizon.irrValues].sort((a, b) => a - b);
			const tailCount = Math.max(1, Math.floor(sortedIrr.length * 0.1));
			const shortfall = mean(sortedIrr.slice(0, tailCount));
			return {
				years: horizon.years,
				irr: irrDist,
				totalReturn: distribution(horizon.returnValues) ?? {
					p10: 0,
					p50: 0,
					p90: 0,
					mean: 0,
				},
				probabilityLossPct: (horizon.losses / simulations) * 100,
				expectedShortfallIrrPct: shortfall == null ? null : shortfall * 100,
				exitValue: distribution(horizon.exitValues) ?? {
					p10: 0,
					p50: 0,
					p90: 0,
					mean: 0,
				},
				annualNetIncomeYear1: input.year1NetIncome,
			};
		}),
	};
}
