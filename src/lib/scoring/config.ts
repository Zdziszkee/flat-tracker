/**
 * Versioned constants for the transparent alert score.
 *
 * Every number here is a policy choice, not a learned parameter. Changing any
 * value requires a new `SCORE_VERSION` so stored scores stay auditable.
 */

export const SCORE_VERSION = "2027.6";

/** Minimum score components for an offer to enter the alert list. */
export const ALERT_GATES = {
	minValueScore: 55,
	minConfidence: 0.5,
	/** Asking price must be at least this far below the local comparable median. */
	minDiscountPct: 10,
} as const;

export type AlertSegment = "flat" | "house" | "plot";

export interface SegmentWeights {
	value: number;
	transit: number;
	green: number;
	property: number;
	risk: number;
}

/**
 * Segment weights calibrated against the pooled hedonic literature
 * (Boucher 2026, UQO WP21: 242 studies, 18,831 coefficients, extending
 * Sirmans et al. 2005):
 * - Flats: structural core (age, condition, floor) plus accessibility drive
 *   most non-price variance. Green space premium averages near zero for
 *   apartments (pooled CI spans zero), so green drops to 0.10 and property
 *   rises to 0.15.
 * - Houses: lot-size elasticity is only 0.09 once living area is
 *   controlled, but garage +5.4%, garden +6.4%, parking +6.3% and building
 *   condition +7.4% are all structural, so property rises to 0.25.
 * - Plots: no building exists, buildability (zoning, media, road access)
 *   IS the product, so property dominates the non-price side at 0.35.
 * Value stays the largest weight everywhere: the alert exists to surface
 * mispricing, amenities only break ties and filter traps.
 */
export const SEGMENT_WEIGHTS: Record<AlertSegment, SegmentWeights> = {
	flat: { value: 0.5, transit: 0.2, green: 0.1, property: 0.15, risk: 0.05 },
	house: { value: 0.45, transit: 0.1, green: 0.15, property: 0.25, risk: 0.05 },
	plot: { value: 0.4, transit: 0.05, green: 0.15, property: 0.35, risk: 0.05 },
};

/** Distance bands in metres. First band that contains the distance wins. */
export type DistanceBands = ReadonlyArray<readonly [number, number]>;

export const DISTANCE_BANDS = {
	tram: [
		[150, 100],
		[300, 90],
		[600, 75],
		[1000, 60],
		[1500, 40],
		[3000, 15],
	],
	bus: [
		[200, 90],
		[400, 80],
		[800, 60],
		[1500, 40],
		[3000, 15],
	],
	park: [
		[150, 100],
		[300, 90],
		[600, 75],
		[1000, 60],
		[2000, 35],
	],
	forest: [
		[150, 100],
		[300, 90],
		[600, 75],
		[1200, 55],
		[2500, 30],
	],
	water: [
		[150, 100],
		[300, 90],
		[600, 75],
		[1200, 55],
		[2500, 30],
	],
	center: [
		[1000, 100],
		[2000, 90],
		[4000, 70],
		[8000, 50],
		[15000, 30],
	],
} as const satisfies Record<string, DistanceBands>;

/**
 * Value score anchors: raw discount below the local comparable median ->
 * score. Piecewise linear between anchors, clamped at both ends. Strongly
 * diminishing returns: the first 10% of discount adds 30 points, the next
 * 10% adds 15, and the third only 5. 30%+ is the maximum, more adds nothing.
 */
export const VALUE_CURVE = [
	[-0.3, 0],
	[-0.2, 5],
	[-0.1, 20],
	[0, 50],
	[0.1, 80],
	[0.2, 95],
	[0.3, 100],
] as const satisfies ReadonlyArray<readonly [number, number]>;

export function valueCurveScore(discount: number): number {
	const first = VALUE_CURVE[0];
	const last = VALUE_CURVE[VALUE_CURVE.length - 1];
	if (!Number.isFinite(discount)) return 50;
	if (discount <= first[0]) return first[1];
	if (discount >= last[0]) return last[1];
	for (let i = 1; i < VALUE_CURVE.length; i++) {
		const prev = VALUE_CURVE[i - 1];
		const next = VALUE_CURVE[i];
		if (prev && next && discount <= next[0]) {
			const t = (discount - prev[0]) / (next[0] - prev[0]);
			return prev[1] + t * (next[1] - prev[1]);
		}
	}
	return last[1];
}

/** Confidence assigned to a comparable set by its reported level. */
export const ESTIMATE_CONFIDENCE = {
	high: 0.95,
	medium: 0.75,
	low: 0.45,
} as const;

/**
 * Plot value confidence for a listing-only comparable set, used INSTEAD of
 * `ESTIMATE_CONFIDENCE[level]` when fewer than three RCN comps survive.
 *
 * Why plots need their own base: the offer-model confidence level is built
 * for RCN-backed unit comparables (rcnCount, same-building matches, recent
 * transactions, time adjustment). With no RCN comps at all the level is
 * capped at "low" (0.45) for EVERY segment, but for flats and houses that
 * is a temporary data gap, while for plots it is close to the structural
 * norm: RCN publishes very few pure land transactions, and plot asking
 * prices within a small radius are homogeneous land asking prices with no
 * building attributes left to mismatch. The flat/house treatment (0.45
 * base) combined with the plot segment weights (value 0.40, property
 * 0.35 at 0.55 confidence) made the 0.5 gate mathematically unreachable
 * at realistic comp spreads. 0.65 says a listing-only land comp set is
 * worth more than a listing-only unit comp set, not that it is RCN-grade.
 */
export const PLOT_LISTING_BASE_CONFIDENCE = 0.65;

/**
 * Listing-only comparable discount for plots. Other segments use 0.85;
 * land asks are less negotiable and more homogeneous, so the asking-vs-
 * asking comparison loses less trust than a unit comparison does.
 */
export const PLOT_LISTING_RCN_FACTOR = 0.9;

/**
 * Plot comp-spread floor. Plot comps mix building, agricultural and
 * recreational land, so the interquartile spread is structurally wider
 * than a flat comp set without meaning the median is wrong. The generic
 * spread factor decays to 0.45 at 40%+; for plots it never drops below
 * this floor. A wide spread still lowers the confidence and keeps the
 * `wide_comp_spread` risk flag.
 */
export const PLOT_SPREAD_FACTOR_FLOOR = 0.7;

export function clamp(value: number, min = 0, max = 100): number {
	return Math.min(max, Math.max(min, value));
}

export function distanceScore(
	meters: number | null | undefined,
	bands: DistanceBands,
	fallback = 20,
): number {
	if (meters == null || !Number.isFinite(meters) || meters < 0) return fallback;
	for (const [limit, score] of bands) {
		if (meters <= limit) return score;
	}
	return fallback;
}

export function linearScore(
	value: number | null | undefined,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	fallback = 50,
): number {
	if (value == null || !Number.isFinite(value) || x0 === x1) return fallback;
	const score = y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
	return clamp(score, Math.min(y0, y1), Math.max(y0, y1));
}
