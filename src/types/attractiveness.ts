/** Shared shapes for the Poland-tailored attractiveness score. */

import type { GeoUniqueness } from "#/lib/valuation/uniqueness-geo";

export type AttractivenessSegment = "apartment" | "house" | "plot";
export type ScoreComponentKey =
	| "value"
	| "market"
	| "location"
	| "property"
	| "uniqueness"
	| "risk";

export interface ScoreComponentDto {
	key: ScoreComponentKey;
	label: string;
	score: number;
	weight: number;
	confidence: number;
}

export interface AttractivenessDto {
	score: number;
	label: string;
	segment: AttractivenessSegment;
	/** 0..1; low values shrink the score toward neutral instead of inventing data. */
	confidence: number;
	components: ScoreComponentDto[];
	strengths: string[];
	risks: string[];
	notes: string[];
	geo: GeoUniqueness | null;
}
