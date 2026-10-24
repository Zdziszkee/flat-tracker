/**
 * Shared price-index primitives. Kept free of DB and framework imports so
 * the chain-linking and time-adjustment rules can be tested deterministically.
 */

export type ValuationSegment =
	| "flat"
	| "flat_primary"
	| "flat_secondary"
	| "house"
	| "plot";

export type IndexGeographyType =
	| "district"
	| "grid10"
	| "region"
	| "external_city";

export interface IndexPoint {
	segment: ValuationSegment;
	geographyType: IndexGeographyType;
	geographyKey: string;
	period: string;
	indexValue: number;
	medianPriceM2: number | null;
	sampleCount: number;
	source: string;
}

export interface IndexStratum {
	band: string;
	median: number;
	count: number;
}

export interface PeriodObservation {
	period: string;
	overallMedian: number;
	overallCount: number;
	strata: IndexStratum[];
}

/** One grouped median row as returned by the index-rebuild SQL. */
export interface MedianPeriodRow {
	period: string;
	areaBand: string;
	bandN: number;
	bandMedian: number | null;
	overallN: number;
	overallMedian: number | null;
}

/**
 * Fold grouped median rows into one observation per period. Only the rows at
 * the overall-median positions carry `overallMedian`; every other area band
 * has it as NULL. Those band rows are the input to the stratified chain, so
 * they must be kept even when the overall value is absent.
 */
export function observationsFromMedianRows(
	rows: readonly MedianPeriodRow[],
): PeriodObservation[] {
	const byPeriod = new Map<string, PeriodObservation>();
	for (const row of rows) {
		let observation = byPeriod.get(row.period);
		if (!observation) {
			observation = {
				period: row.period,
				overallMedian: 0,
				overallCount: 0,
				strata: [],
			};
			byPeriod.set(row.period, observation);
		}
		if (row.overallN > 0) {
			observation.overallCount = Math.max(
				observation.overallCount,
				row.overallN,
			);
		}
		if (row.overallMedian != null && row.overallMedian > 0) {
			observation.overallMedian = row.overallMedian;
		}
		if (row.bandMedian != null && row.bandMedian > 0 && row.bandN > 0) {
			observation.strata.push({
				band: row.areaBand,
				median: row.bandMedian,
				count: row.bandN,
			});
		}
	}
	return [...byPeriod.values()].filter(
		(observation) =>
			observation.overallMedian > 0 && observation.overallCount > 0,
	);
}

export interface ChainedObservation extends PeriodObservation {
	indexValue: number;
}

export function quarterOf(date: Date | number): string {
	const value = typeof date === "number" ? new Date(date * 1000) : date;
	const year = value.getUTCFullYear();
	const quarter = Math.floor(value.getUTCMonth() / 3) + 1;
	return `${year}-Q${quarter}`;
}

export function currentQuarter(now = new Date()): string {
	return quarterOf(now);
}

/** ~10 km grid cells; no external geocoding dependency. */
export function grid10Key(lat: number, lng: number): string {
	return `${lat.toFixed(1)}:${lng.toFixed(1)}`;
}

export function normalizeDistrict(value: string | null): string | null {
	const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
	return normalized || null;
}

export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
		: (sorted[middle] ?? null);
}

/** Linear weighted quantile over (value, weight) pairs. */
export function weightedQuantile(
	values: ReadonlyArray<{ value: number; weight: number }>,
	quantile: number,
): number | null {
	const usable = values
		.filter((entry) => entry.weight > 0 && Number.isFinite(entry.value))
		.sort((a, b) => a.value - b.value);
	if (usable.length === 0) return null;
	const total = usable.reduce((sum, entry) => sum + entry.weight, 0);
	if (total <= 0) return null;
	const target = Math.min(1, Math.max(0, quantile)) * total;
	let cumulative = 0;
	for (const entry of usable) {
		cumulative += entry.weight;
		if (cumulative >= target) return entry.value;
	}
	return usable[usable.length - 1]?.value ?? null;
}

/**
 * Chain a series of stratified quarterly medians. The first usable quarter is
 * 100; later links use common area bands with enough observations, falling
 * back to the overall median only when no reliable common stratum exists.
 */
export function chainStratifiedIndex(
	observations: readonly PeriodObservation[],
): ChainedObservation[] {
	const sorted = [...observations].sort((a, b) =>
		a.period.localeCompare(b.period),
	);
	const out: ChainedObservation[] = [];
	let previous: ChainedObservation | null = null;
	for (const observation of sorted) {
		if (observation.overallCount < 8 || observation.overallMedian <= 0) {
			continue;
		}
		if (!previous) {
			const first = { ...observation, indexValue: 100 };
			out.push(first);
			previous = first;
			continue;
		}
		const previousBands = new Map(
			previous.strata.map((stratum) => [stratum.band, stratum]),
		);
		const ratios: Array<{ value: number; weight: number }> = [];
		for (const stratum of observation.strata) {
			const before = previousBands.get(stratum.band);
			if (!before || before.median <= 0) continue;
			const weight = Math.min(stratum.count, before.count);
			if (stratum.count < 3 || before.count < 3) continue;
			ratios.push({ value: stratum.median / before.median, weight });
		}
		let change = weightedQuantile(ratios, 0.5);
		if (change == null && previous.overallMedian > 0) {
			change = observation.overallMedian / previous.overallMedian;
		}
		// A >2x or <0.5x quarterly jump is almost certainly a tiny or
		// contaminated sample; leave a gap so the caller falls back to a
		// wider geography instead of amplifying it into every comp.
		if (change == null || change <= 0.5 || change >= 2) continue;
		const next: ChainedObservation = {
			...observation,
			indexValue: previous.indexValue * change,
		};
		out.push(next);
		previous = next;
	}
	return out;
}

export interface TimeAdjustment {
	factor: number;
	fromPeriod: string;
	toPeriod: string;
	fromIndex: number;
	toIndex: number;
}

/** Ratio between the latest usable point and the comp's quarter. */
export function timeAdjustment(
	series: readonly IndexPoint[],
	compPeriod: string,
	asOfPeriod = currentQuarter(),
): TimeAdjustment | null {
	const usable = series
		.filter(
			(point) =>
				point.indexValue > 0 &&
				point.period <= asOfPeriod &&
				point.sampleCount > 0,
		)
		.sort((a, b) => a.period.localeCompare(b.period));
	if (usable.length === 0) return null;
	const latest = usable[usable.length - 1];
	if (!latest) return null;
	let from: IndexPoint | undefined;
	for (const point of usable) {
		if (point.period <= compPeriod) from = point;
		else break;
	}
	// Before the first observed quarter, use the first point rather than
	// pretending there was no market change.
	from ??= usable[0];
	if (!from || from.indexValue <= 0) return null;
	return {
		factor: latest.indexValue / from.indexValue,
		fromPeriod: from.period,
		toPeriod: latest.period,
		fromIndex: from.indexValue,
		toIndex: latest.indexValue,
	};
}
