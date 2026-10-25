/**
 * Small, dependency-free numeric toolkit for the forecasting pipeline.
 * Everything here is pure so the validation script can pin the math.
 */

export type ForecastFrequency = "month" | "quarter";

export const PERIODS_PER_YEAR: Record<ForecastFrequency, number> = {
	month: 12,
	quarter: 4,
};

/** YYYY-MM, YYYY-Qn or YYYY-MM-DD -> a monotonic period ordinal. */
export function periodOrdinal(period: string): number | null {
	const month = period.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/u);
	if (month?.[1] && month[2]) {
		const m = Number(month[2]);
		if (m < 1 || m > 12) return null;
		return Number(month[1]) * 12 + m - 1;
	}
	const quarter = period.match(/^(\d{4})-Q([1-4])$/u);
	if (quarter?.[1] && quarter[2]) {
		return Number(quarter[1]) * 4 + Number(quarter[2]) - 1;
	}
	return null;
}

export function periodFromOrdinal(
	ordinal: number,
	frequency: ForecastFrequency,
): string {
	const perYear = PERIODS_PER_YEAR[frequency];
	const year = Math.floor(ordinal / perYear);
	const index = ordinal - year * perYear;
	return frequency === "month"
		? `${year}-${String(index + 1).padStart(2, "0")}`
		: `${year}-Q${index + 1}`;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function mean(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function standardDeviation(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const avg = mean(values) ?? 0;
	const variance =
		values.reduce((sum, value) => sum + (value - avg) ** 2, 0) /
		(values.length - 1);
	return Math.sqrt(variance);
}

export function median(values: readonly number[]): number | null {
	return quantile(values, 0.5);
}

/** Linear-interpolated empirical quantile. */
export function quantile(
	values: readonly number[],
	probability: number,
): number | null {
	const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (usable.length === 0) return null;
	const p = clamp(probability, 0, 1);
	const position = (usable.length - 1) * p;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	const fraction = position - lower;
	return (
		(usable[lower] ?? 0) * (1 - fraction) + (usable[upper] ?? 0) * fraction
	);
}

/** Linear weighted quantile over (value, weight) pairs. */
export function weightedQuantile(
	values: ReadonlyArray<{ value: number; weight: number }>,
	probability: number,
): number | null {
	const usable = values
		.filter((entry) => entry.weight > 0 && Number.isFinite(entry.value))
		.sort((a, b) => a.value - b.value);
	if (usable.length === 0) return null;
	const total = usable.reduce((sum, entry) => sum + entry.weight, 0);
	const target = clamp(probability, 0, 1) * total;
	let cumulative = 0;
	for (const entry of usable) {
		cumulative += entry.weight;
		if (cumulative >= target) return entry.value;
	}
	return usable[usable.length - 1]?.value ?? null;
}

export function pearsonCorrelation(
	a: readonly number[],
	b: readonly number[],
): number | null {
	const n = Math.min(a.length, b.length);
	if (n < 3) return null;
	const x = a.slice(0, n);
	const y = b.slice(0, n);
	const mx = mean(x) ?? 0;
	const my = mean(y) ?? 0;
	let covariance = 0;
	let vx = 0;
	let vy = 0;
	for (let i = 0; i < n; i++) {
		const dx = (x[i] ?? 0) - mx;
		const dy = (y[i] ?? 0) - my;
		covariance += dx * dy;
		vx += dx * dx;
		vy += dy * dy;
	}
	if (vx <= 0 || vy <= 0) return null;
	return clamp(covariance / Math.sqrt(vx * vy), -1, 1);
}

/** Deterministic PRNG: identical offer IDs produce identical scenarios. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Standard normal draw (Box-Muller, one variate is enough). */
export function normalDraw(rng: () => number): number {
	const u1 = Math.max(rng(), Number.EPSILON);
	const u2 = rng();
	return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Cholesky decomposition of a symmetric positive-semidefinite matrix. */
export function cholesky(matrix: readonly (readonly number[])[]): number[][] {
	const n = matrix.length;
	const lower = Array.from({ length: n }, () => Array<number>(n).fill(0));
	for (let i = 0; i < n; i++) {
		for (let j = 0; j <= i; j++) {
			let sum = matrix[i]?.[j] ?? 0;
			for (let k = 0; k < j; k++) {
				sum -= (lower[i]?.[k] ?? 0) * (lower[j]?.[k] ?? 0);
			}
			if (i === j) {
				// Small jitter keeps mildly non-PD empirical correlations usable.
				lower[i][j] = Math.sqrt(Math.max(sum, 1e-9));
			} else {
				lower[i][j] = sum / (lower[j]?.[j] ?? 1);
			}
		}
	}
	return lower;
}

export function logit(value: number): number {
	const p = clamp(value, 1e-4, 1 - 1e-4);
	return Math.log(p / (1 - p));
}

export function expit(value: number): number {
	return 1 / (1 + Math.exp(-value));
}

export const Z80 = 1.2815515655446004;
