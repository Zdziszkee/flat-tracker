/**
 * Shared, dependency-free numeric primitives.
 *
 * This is the single definition site for the small statistics the valuation,
 * forecasting, scoring and chart code need. It stays free of DB, framework and
 * domain imports so the math can be tested deterministically. Domain policy
 * (weights, curves, distance bands) belongs to the module that owns it.
 *
 * Empty-sample semantics are uniform: every reduction that has no usable
 * input returns `null`, never NaN. `clamp` always returns a finite bound.
 */

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Linear-interpolated empirical quantile. Non-finite values are dropped; an
 * empty sample (or one with no finite value) yields null.
 */
export function quantile(
	values: readonly number[],
	probability: number,
): number | null {
	if (!Number.isFinite(probability)) return null;
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

/** Interpolated median (`quantile(values, 0.5)`); null for an empty sample. */
export function median(values: readonly number[]): number | null {
	return quantile(values, 0.5);
}

/**
 * Non-interpolated median: the observed value at floor(n / 2), i.e. the upper
 * of the two middle observations for an even sample. Charts and summaries that
 * must show a real observed value use this instead of the interpolated
 * midpoint. Null for an empty sample.
 */
export function upperMedian(values: readonly number[]): number | null {
	const usable = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (usable.length === 0) return null;
	return usable[Math.floor(usable.length / 2)] ?? null;
}

/**
 * Linear weighted quantile over (value, weight) pairs. Entries with a
 * non-positive weight or a non-finite value are ignored; an empty sample or a
 * non-positive total weight yields null. Ties resolve to the first entry whose
 * cumulative weight reaches the target.
 */
export function weightedQuantile(
	values: ReadonlyArray<{ value: number; weight: number }>,
	probability: number,
): number | null {
	if (!Number.isFinite(probability)) return null;
	const usable = values
		.filter((entry) => entry.weight > 0 && Number.isFinite(entry.value))
		.sort((a, b) => a.value - b.value);
	if (usable.length === 0) return null;
	const total = usable.reduce((sum, entry) => sum + entry.weight, 0);
	if (total <= 0) return null;
	const target = clamp(probability, 0, 1) * total;
	let cumulative = 0;
	for (const entry of usable) {
		cumulative += entry.weight;
		if (cumulative >= target) return entry.value;
	}
	return usable[usable.length - 1]?.value ?? null;
}
