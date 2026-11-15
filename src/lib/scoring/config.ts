/**
 * Versioned constants for the transparent alert score.
 *
 * Every number here is a policy choice, not a learned parameter. Changing any
 * value requires a new `SCORE_VERSION` so stored scores stay auditable.
 */

export const SCORE_VERSION = "2027.1";

/** Buyer-side negotiation margin applied to the asking price. */
export const NEGOTIATION_MARGIN = 0.15;

/** Minimum score components for an offer to enter the alert list. */
export const ALERT_GATES = {
	minValueScore: 55,
	minConfidence: 0.5,
	minDiscountPct: 20,
} as const;

export type AlertSegment = "flat" | "house" | "plot";

export interface SegmentWeights {
	value: number;
	transit: number;
	green: number;
	property: number;
	risk: number;
}

export const SEGMENT_WEIGHTS: Record<AlertSegment, SegmentWeights> = {
	flat: { value: 0.5, transit: 0.2, green: 0.15, property: 0.1, risk: 0.05 },
	house: { value: 0.45, transit: 0.1, green: 0.25, property: 0.15, risk: 0.05 },
	plot: { value: 0.4, transit: 0.1, green: 0.3, property: 0.15, risk: 0.05 },
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

/** Confidence assigned to a comparable set by its reported level. */
export const ESTIMATE_CONFIDENCE = {
	high: 0.95,
	medium: 0.75,
	low: 0.45,
} as const;

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
