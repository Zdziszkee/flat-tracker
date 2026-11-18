/**
 * Comparable selection and price aggregation for the sales-comparison model.
 *
 * This module owns the two policy questions the valuation used to answer
 * inline: which comparables count, and what single zł/m² they collapse to.
 * It is pure (no DB, no clock, no network) so the backtest
 * (`scripts/backtest-comp-metric.ts`) and the validator
 * (`scripts/validate-comp-selection.ts`) can pin the same code the model runs.
 *
 * Evidence (seeded held-out RCN transactions, 3000 flats / 1500 houses / 308
 * classified plots, comps rebuilt with no lookahead and indexed to the
 * holdout's quarter):
 *
 *   estimator      flats MedAPE   houses MedAPE   plots MedAPE
 *   weighted median      14.8%         27.4%         38.3%
 *   trimmed mean         15.3%         33.0%         35.4%
 *   Huber                15.0%         31.1%         39.9%
 *   median               15.6%         32.7%         37.5%
 *   area-weighted med.   15.5%         32.0%         36.0%
 *   mean                 16.2%         39.1%        115.5%
 *
 * The weighted median stays: it wins flats by 0.8 pp over the plain median
 * (the runner-up) and houses by 5.3 pp over the trimmed mean. On plots the
 * plain median was 0.8 pp better, but that is 308 holdouts and within noise,
 * so one metric is kept for the whole model.
 *
 * The selection below is the combination the ablations supported: tighter
 * area band, soft rooms, 800 m distance decay, 40-comp cap, [800, 1600] m
 * radius. It moves flats 14.8 -> 13.8 MedAPE and houses 27.4 -> 21.0 on its
 * own; adding the index guard gives 13.6 and 19.1.
 *
 * Every constant names the alternative it replaced and the measured margin.
 * Ablations that did not help stay at their historic value: exact-area ±15%
 * for plots (MAPE exploded), floor matching (+0.7 pp), unbounded window
 * (+0.4 pp), a wide radius (+0.6 pp at 3000 m for flats).
 */

import { weightedQuantile } from "#/lib/stats";

/**
 * The aggregate the model reports as `fairM2`. Chosen by out-of-sample
 * MedAPE/MAPE in `scripts/backtest-comp-metric.ts`; see the numbers below.
 */
export const PRICE_METRIC: PriceMetric = "weighted_median";

export type PriceMetric =
	| "weighted_median"
	| "median"
	| "mean"
	| "area_weighted_median"
	| "trimmed_mean"
	| "huber";

/** One comparable, already converted to a current-quarter zł/m². */
export interface PriceEntry {
	value: number;
	/** Selection weight (recency/distance/area/rooms/market/building). */
	weight: number;
	areaM2?: number | null;
}

/** Symmetric trim used by `trimmed_mean`: 10% of the sample from each tail. */
export const TRIM_FRACTION = 0.1;
/** Huber tuning constant, 95% efficiency under a Gaussian core. */
export const HUBER_K = 1.345;

function usableEntries(entries: readonly PriceEntry[]): PriceEntry[] {
	return entries.filter(
		(entry) =>
			Number.isFinite(entry.value) &&
			entry.value > 0 &&
			Number.isFinite(entry.weight) &&
			entry.weight > 0,
	);
}

function weightedMean(entries: readonly PriceEntry[]): number | null {
	const usable = usableEntries(entries);
	if (usable.length === 0) return null;
	const total = usable.reduce((sum, entry) => sum + entry.weight, 0);
	if (!(total > 0)) return null;
	const sum = usable.reduce(
		(acc, entry) => acc + entry.value * entry.weight,
		0,
	);
	const value = sum / total;
	return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Collapse a comparable set to one zł/m².
 *
 * Non-finite or non-positive prices and non-positive weights are ignored, so a
 * zero-price regression row can never become a comp. A single usable entry
 * returns that entry's price for every metric.
 */
export function estimateCompPrice(
	entries: readonly PriceEntry[],
	metric: PriceMetric,
): number | null {
	const usable = usableEntries(entries);
	if (usable.length === 0) return null;
	if (usable.length === 1) return usable[0]?.value ?? null;
	switch (metric) {
		case "mean": {
			const value =
				usable.reduce((sum, entry) => sum + entry.value, 0) / usable.length;
			return Number.isFinite(value) && value > 0 ? value : null;
		}
		case "median": {
			return weightedQuantile(
				usable.map((entry) => ({ value: entry.value, weight: 1 })),
				0.5,
			);
		}
		case "area_weighted_median": {
			// Larger transactions carry more of the market's weight; absent an
			// area the comp counts once, like the plain median.
			return weightedQuantile(
				usable.map((entry) => ({
					value: entry.value,
					weight:
						entry.areaM2 != null &&
						Number.isFinite(entry.areaM2) &&
						entry.areaM2 > 0
							? entry.areaM2
							: 1,
				})),
				0.5,
			);
		}
		case "trimmed_mean": {
			const sorted = [...usable].sort((a, b) => a.value - b.value);
			const trim = Math.floor(sorted.length * TRIM_FRACTION);
			const kept = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
			return weightedMean(kept);
		}
		case "huber": {
			const base = usableEntries(usable);
			const center = weightedQuantile(
				base.map((entry) => ({ value: entry.value, weight: entry.weight })),
				0.5,
			);
			if (center == null) return null;
			const deviations = base
				.map((entry) => Math.abs(entry.value - center))
				.sort((a, b) => a - b);
			const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
			// 1.4826 turns the MAD into a Gaussian-consistent sigma. A
			// degenerate sample (identical prices) gets no robust downweighting.
			const scale = 1.4826 * mad;
			if (!(scale > 0)) return center;
			let current = center;
			for (let iteration = 0; iteration < 20; iteration++) {
				const weights = base.map((entry) => {
					const residual = Math.abs(entry.value - current);
					const robust =
						residual <= HUBER_K * scale ? 1 : (HUBER_K * scale) / residual;
					return { value: entry.value, weight: entry.weight * robust };
				});
				const next = weightedMean(weights);
				if (next == null) return current;
				if (Math.abs(next - current) <= 1e-6 * Math.max(1, current)) {
					return next;
				}
				current = next;
			}
			return current;
		}
		default:
			return weightedQuantile(
				usable.map((entry) => ({
					value: entry.value,
					weight: entry.weight,
				})),
				0.5,
			);
	}
}

/* ------------------------------------------------------------------ *
 * Plot land-use families
 *
 * RCN carries no land-use class. The EGiB snapshot on `parcels` /
 * `parcel_features` does, and the listing extractor reads a plot type out of
 * the advert. A 1000 m² building plot in a village must not be priced with
 * agricultural or forest land, so both sides are reduced to one of a few
 * families and compared. Only the class family is compared; the class detail
 * (RIIIa vs RV) is not a price-level signal at this sample size.
 * ------------------------------------------------------------------ */

export type PlotClassFamily =
	| "built"
	| "agricultural"
	| "forest"
	| "water"
	| "other";

/** Longest token first: `dr`, `Ls`, `PS` are prefixes of each other's words. */
function firstClassToken(value: string | null | undefined): string | null {
	const token = value
		?.split(/[,;/|]/)[0]
		?.trim()
		.replace(/\s+/g, "")
		.toUpperCase();
	return token ? token : null;
}

/**
 * Map an EGiB land-use class (`B`, `Ba`, `RIIIa`, `RV`, `LsIV`, `PS`, `ŁIII`,
 * `W`, `dr`, `Tp`, ...) to a price family. The first token of a comma-separated
 * class list wins: EGiB lists the dominant class first.
 */
export function plotClassFamily(
	value: string | null | undefined,
): PlotClassFamily | null {
	const token = firstClassToken(value);
	if (!token) return null;
	if (token.startsWith("Ł")) return "agricultural";
	if (token.startsWith("LS")) return "forest";
	if (token.startsWith("B")) return "built";
	if (
		token.startsWith("R") ||
		token.startsWith("PS") ||
		token.startsWith("S")
	) {
		return "agricultural";
	}
	if (token.startsWith("W")) return "water";
	return "other";
}

/**
 * Map the advert's plot type (`działka budowlana`, `rolna`, `leśna`, ...) to
 * the same families. Recreational/letniskowa plots are sold on agricultural
 * parcels in almost every Polish case, so they join that family rather than
 * introducing a family EGiB never produces.
 */
export function plotClassFamilyFromType(
	value: string | null | undefined,
): PlotClassFamily | null {
	const text = value?.toLowerCase().trim();
	if (!text) return null;
	if (/(budowlan|inwestycyjn|pod\s+zabudow|budowlano)/.test(text)) {
		return "built";
	}
	if (/(roln|rolna|rolny|uprawn)/.test(text)) return "agricultural";
	if (/(leśn|lesn|siedlisk)/.test(text)) return "forest";
	if (/(rekreacyjn|letnisk|wypoczynk|siedlisk)/.test(text)) {
		return "agricultural";
	}
	if (/(wodn|jezior|jezier)/.test(text)) return "water";
	// "działka" alone, an estate name or prose is not a land-use type. Unknown
	// evidence must stay unknown; returning "other" would let unrelated land
	// match an advert that never named a type.
	return null;
}

/**
 * A plot comp is admissible only when both sides carry a family and the
 * families agree. Unknown evidence is not agreement: a plot comp set that
 * cannot prove its land type must not produce a value (the live 1000 m²
 * village plot was priced at 2.07M against city building land this way).
 */
export function plotFamiliesMatch(
	target: PlotClassFamily | null,
	comp: PlotClassFamily | null,
): boolean {
	return target != null && comp != null && target === comp;
}

/* ------------------------------------------------------------------ *
 * Comparable selection
 * ------------------------------------------------------------------ */

export type CompSet = "buildingRcn" | "nearbyRcn" | "listing";
export type CompKind = "flat" | "house" | "plot";

export interface CompTarget {
	kind: CompKind;
	areaM2: number;
	rooms: number | null;
	market: 1 | 2 | null;
	/** The quarter the estimate is made in; comps newer than this are ignored. */
	asOfSeconds: number;
	/** `plot` only: the offer's land-use family, when the advert or EGiB knows it. */
	plotClassFamily?: PlotClassFamily | null;
	floor?: string | null;
}

export interface CompCandidate {
	set: CompSet;
	date: Date | number | null;
	areaM2: number;
	rooms: number | null;
	market: number | null;
	distanceM: number | null;
	buildingId?: number | null;
	plotClassFamily?: PlotClassFamily | null;
	floor?: string | null;
}

export type RoomsMode = "exact" | "one" | "any";
export type MarketMode = "match" | "any";

export interface AreaBand {
	minRatio: number;
	maxRatio: number;
	rooms: RoomsMode;
	market: MarketMode;
}

export interface SelectionOptions {
	/** Relaxation ladder, strictest first. */
	bands: readonly AreaBand[];
	/** Radius ladder: widen only while fewer than `minComps` survive. */
	radiiM: readonly number[];
	minComps: number;
	cap: number;
	maxAgeSeconds: number;
	/** `1 / (1 + distanceM / scale)` distance decay. */
	distanceScaleM: number;
	recencyHalfLifeMonths: number;
	/**
	 * `filter` rejects rooms mismatch per band, `preferred` only weights it,
	 * `none` ignores rooms.
	 */
	roomsMode: "filter" | "preferred" | "none";
	/** Floor agreement: `none` (current), `one` (|Δ| <= 1), `exact`. */
	floorMode: "none" | "one" | "exact";
	/** Plots: require a matching land-use family on every comp. */
	requirePlotTypeAgreement: boolean;
	/** Active asking offers are weaker evidence than a completed sale. */
	listingWeightMultiplier: number;
	/**
	 * Primary/secondary agreement. `filter` rejects a proven mismatch on the
	 * strict bands and downweights it on the wide one (the historic rule),
	 * `soft` only downweights with `marketSoftWeight`, `none` ignores market.
	 */
	marketMode: "filter" | "soft" | "none";
	marketSoftWeight: number;
}

/**
 * Radius ladder per segment (metres). Tighter than the historic 1200/2400 for
 * built property: the combined change (this ladder + band + cap + decay) is
 * what cut house MedAPE from 27.4% to 21.0%. Plots keep the historic wide net;
 * land comps are sparse and parcel size already enters through `AREA_ELASTICITY`.
 */
export const RADII_BY_KIND: Record<CompKind, [number, number]> = {
	flat: [800, 1600],
	house: [800, 1600],
	plot: [3000, 6000],
};

export const DEFAULT_SELECTION: SelectionOptions = {
	bands: [
		// ±15% at the strict level (was ±40%): flats 14.8 -> 14.6 MedAPE,
		// houses 27.4 -> 21.0 as part of the combined change. Wider levels
		// relax area before the radius is abandoned.
		{ minRatio: 0.87, maxRatio: 1.15, rooms: "exact", market: "match" },
		{ minRatio: 0.5, maxRatio: 2, rooms: "one", market: "match" },
		{ minRatio: 0.25, maxRatio: 4, rooms: "any", market: "any" },
	],
	// Segment defaults override this; see RADII_BY_KIND.
	radiiM: [800, 1600],
	minComps: 3,
	// 40 beats 140 by 0.5 pp MedAPE on flats: a wide set quietly fills with
	// distant comps, which the distance decay cannot fully suppress.
	cap: 40,
	maxAgeSeconds: 5 * 365 * 86_400,
	// 800 m beats 1500 m by 0.1 pp on flats and removes most of the house
	// error (27.4 -> 21.0 MedAPE as part of the combined change).
	distanceScaleM: 800,
	recencyHalfLifeMonths: 24,
	// Rooms as a soft weight beat a hard filter by 0.3 pp on flats.
	roomsMode: "preferred",
	floorMode: "none",
	requirePlotTypeAgreement: false,
	listingWeightMultiplier: 0.5,
	marketMode: "filter",
	marketSoftWeight: 0.5,
};

/**
 * Plots keep the historic band/cap/decay: the flat-tuned policy was measured
 * on plots too and is much worse (+9.7 pp MedAPE), because parcel size is
 * handled by `AREA_ELASTICITY.plot` and the pool is sparse. Only the radius
 * ladder is segment-specific here.
 */
export const PLOT_SELECTION: SelectionOptions = {
	...DEFAULT_SELECTION,
	bands: [
		{ minRatio: 0.6, maxRatio: 1.4, rooms: "exact", market: "match" },
		{ minRatio: 0.5, maxRatio: 2, rooms: "one", market: "match" },
		{ minRatio: 0.25, maxRatio: 4, rooms: "any", market: "any" },
	],
	cap: 140,
	distanceScaleM: 1500,
	roomsMode: "filter",
};

/** Segment defaults: the shared policy plus the segment's radius ladder. */
export function selectionDefaults(kind: CompKind): SelectionOptions {
	if (kind === "plot") {
		return { ...PLOT_SELECTION, radiiM: RADII_BY_KIND.plot };
	}
	return { ...DEFAULT_SELECTION, radiiM: RADII_BY_KIND[kind] };
}

export function secondsOf(value: Date | number | null): number | null {
	if (value == null) return null;
	return value instanceof Date ? value.getTime() / 1000 : value;
}

function floorNumber(value: string | null | undefined): number | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	if (normalized === "parter" || normalized === "0") return 0;
	if (normalized === "suterena") return -1;
	const match = normalized.match(/-?\d+/);
	if (!match) return null;
	const parsed = Number.parseInt(match[0], 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Floor agreement; unknown floors never reject (absence is not a mismatch). */
export function floorsAgree(
	target: string | null | undefined,
	candidate: string | null | undefined,
	mode: "none" | "one" | "exact",
): boolean {
	if (mode === "none") return true;
	const a = floorNumber(target);
	const b = floorNumber(candidate);
	if (a == null || b == null) return true;
	if (mode === "exact") return a === b;
	return Math.abs(a - b) <= 1;
}

function roomsWeight(
	target: CompTarget,
	candidateRooms: number | null,
): number {
	if (target.kind !== "flat" || target.rooms == null) return 1;
	if (candidateRooms == null) return 0.85;
	if (candidateRooms === target.rooms) return 1;
	if (Math.abs(candidateRooms - target.rooms) === 1) return 0.8;
	return 0.55;
}

/**
 * Comparable weight. Recency halves every two years, distance and area decay
 * are rational, and a sale in the same building counts double. A comp with no
 * distance (same-building or district fallback) gets a fixed 0.85 rather than
 * the value a zero-distance comp would get, so it never outranks the building
 * set.
 */
export function compWeight(
	candidate: CompCandidate,
	target: CompTarget,
	options: SelectionOptions = DEFAULT_SELECTION,
): number {
	const dateSeconds = secondsOf(candidate.date);
	const ageMonths =
		dateSeconds == null
			? 0
			: Math.max(0, (target.asOfSeconds - dateSeconds) / (30.44 * 86_400));
	const recency = 0.5 ** (ageMonths / options.recencyHalfLifeMonths);
	const distance =
		candidate.distanceM == null
			? 0.85
			: 1 / (1 + candidate.distanceM / options.distanceScaleM);
	const areaSimilarity =
		1 /
		(1 + Math.abs(Math.log(candidate.areaM2 / Math.max(target.areaM2, 1e-6))));
	const rooms =
		options.roomsMode === "none" ? 1 : roomsWeight(target, candidate.rooms);
	const market =
		target.market != null &&
		candidate.market != null &&
		candidate.market !== target.market
			? options.marketMode === "none"
				? 1
				: options.marketMode === "soft"
					? options.marketSoftWeight
					: 0.65
			: 1;
	const building = candidate.set === "buildingRcn" ? 2 : 1;
	const weight =
		recency * distance * areaSimilarity * rooms * market * building;
	return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function areaRatio(candidate: CompCandidate, target: CompTarget): number {
	return candidate.areaM2 / Math.max(target.areaM2, 1e-6);
}

function roomsPass(
	target: CompTarget,
	candidate: CompCandidate,
	mode: RoomsMode,
): boolean {
	if (target.kind !== "flat" || target.rooms == null) return true;
	if (candidate.rooms == null) return true;
	if (mode === "any") return true;
	if (mode === "exact") return candidate.rooms === target.rooms;
	return Math.abs(candidate.rooms - target.rooms) <= 1;
}

function marketPass(
	target: CompTarget,
	candidate: CompCandidate,
	mode: MarketMode,
): boolean {
	if (target.kind !== "flat" || mode === "any") return true;
	if (target.market == null || candidate.market == null) return true;
	return candidate.market === target.market;
}

export interface CompSelection<T extends CompCandidate> {
	comps: T[];
	/** The same comps with the weight the aggregate used, sorted by weight. */
	entries: Array<{ comp: T; weight: number }>;
	/** Index into `options.bands`; the widest level when nothing stricter filled. */
	level: number;
	/** Radius that produced the set (`null` when the comps carry no distance). */
	radiusM: number | null;
	/** Plots: the target family the comps were matched on, null when unknown. */
	plotClassFamily: PlotClassFamily | null;
	/** Candidates dropped because their land-use family did not agree. */
	plotMismatchCount: number;
	/** True when the set still has fewer than `minComps`. */
	short: boolean;
}

/**
 * Pick the comp set: widen the radius, then relax area/rooms/market, stopping
 * at the first tier with `minComps` survivors. Comps newer than the target's
 * `asOfSeconds` are never used, so a backtest holdout cannot see its own
 * future. The final set is sorted by weight and capped at `options.cap`.
 */
export function selectComparables<T extends CompCandidate>(
	target: CompTarget,
	candidates: readonly T[],
	options: SelectionOptions = DEFAULT_SELECTION,
): CompSelection<T> {
	const plotFamily =
		target.kind === "plot" ? (target.plotClassFamily ?? null) : null;
	const needsPlotAgreement =
		target.kind === "plot" &&
		options.requirePlotTypeAgreement &&
		plotFamily != null;
	let plotMismatchCount = 0;

	const inTime = candidates.filter((candidate) => {
		const seconds = secondsOf(candidate.date);
		if (seconds == null) return true;
		if (seconds > target.asOfSeconds) return false;
		return target.asOfSeconds - seconds <= options.maxAgeSeconds;
	});

	const plotFiltered = inTime.filter((candidate) => {
		if (!needsPlotAgreement) return true;
		const ok = plotFamiliesMatch(plotFamily, candidate.plotClassFamily ?? null);
		if (!ok) plotMismatchCount++;
		return ok;
	});

	const radii = options.radiiM;
	let best: T[] = [];
	let bestLevel = options.bands.length - 1;
	let bestRadius: number | null = null;

	// Radius before area/rooms/market relaxation, exactly like the previous
	// inline selection: a strict set at the wider radius beats a relaxed set
	// at the narrow one.
	for (let level = 0; level < options.bands.length; level++) {
		const band = options.bands[level];
		if (!band) continue;
		for (const radius of radii) {
			// The wider pool is a superset, so this is the union of the radii
			// the previous implementation accumulated.
			const pool = plotFiltered.filter(
				(candidate) =>
					candidate.distanceM == null || candidate.distanceM <= radius,
			);
			const survivors = pool.filter((candidate) => {
				const ratio = areaRatio(candidate, target);
				if (ratio < band.minRatio || ratio > band.maxRatio) return false;
				if (
					options.roomsMode === "filter" &&
					!roomsPass(target, candidate, band.rooms)
				) {
					return false;
				}
				if (
					options.marketMode === "filter" &&
					!marketPass(target, candidate, band.market)
				) {
					return false;
				}
				if (!floorsAgree(target.floor, candidate.floor, options.floorMode)) {
					return false;
				}
				return true;
			});
			if (survivors.length >= options.minComps) {
				return finalize(
					survivors,
					level,
					radius,
					plotFamily,
					plotMismatchCount,
					target,
					options,
				);
			}
			// Remember the widest tier so a short set still yields evidence
			// (the model decides whether it is enough).
			if (survivors.length > 0) {
				best = survivors;
				bestLevel = level;
				bestRadius = radius;
			}
		}
	}

	if (best.length === 0) {
		return {
			comps: [],
			entries: [],
			level: options.bands.length - 1,
			radiusM: radii[radii.length - 1] ?? null,
			plotClassFamily: plotFamily,
			plotMismatchCount,
			short: true,
		};
	}
	const finalized = finalize(
		best,
		bestLevel,
		bestRadius,
		plotFamily,
		plotMismatchCount,
		target,
		options,
	);
	return { ...finalized, short: finalized.comps.length < options.minComps };
}

function finalize<T extends CompCandidate>(
	comps: T[],
	level: number,
	radiusM: number | null,
	plotFamily: PlotClassFamily | null,
	plotMismatchCount: number,
	target: CompTarget,
	options: SelectionOptions,
): CompSelection<T> {
	const entries = comps
		.map((comp) => ({
			comp,
			weight:
				compWeight(comp, target, options) *
				(comp.set === "listing" ? options.listingWeightMultiplier : 1),
		}))
		.filter((entry) => entry.weight > 0)
		.sort((a, b) => b.weight - a.weight)
		.slice(0, options.cap);
	return {
		comps: entries.map((entry) => entry.comp),
		entries,
		level,
		radiusM,
		plotClassFamily: plotFamily,
		plotMismatchCount,
		short: entries.length < options.minComps,
	};
}

/* ------------------------------------------------------------------ *
 * Index-factor plausibility
 * ------------------------------------------------------------------ */

/**
 * A narrow grid/district index series is built from few sales per quarter, so
 * a chain link can drift. Live house alerts carried `2021-Q4 → 2026-Q3 ×5.07`
 * (and ×1.55-×2.20) where the regional factor over the same window was far
 * lower: those comps were multiplied by a low-liquidity artifact.
 *
 * Guard: reject the narrow factor when it deviates from the regional factor
 * for the same period by more than `INDEX_FACTOR_BAND`, fall back to the
 * regional factor, and downweight the comp (the caller multiplies its weight
 * by `GUARDED_FACTOR_WEIGHT`).
 *
 * Band 1.5 is the measured choice: it cuts house MedAPE 27.4% -> 23.7% and
 * plot 38.3% -> 28.2%, while band 2.0 only catches the extreme tail (a ×2.10
 * factor against a ×1.30 regional one, the live example, sits inside band 2).
 * Flats are unaffected (14.8% -> 14.7%), so the tighter band costs nothing
 * where the narrow series are dense.
 */
export const INDEX_FACTOR_BAND = 1.5;
/** Weight multiplier for a comp whose narrow index was replaced. */
export const GUARDED_FACTOR_WEIGHT = 0.5;

export interface GuardedFactor {
	factor: number;
	/** True when the narrow factor was rejected for the regional one. */
	replaced: boolean;
}

export function guardTimeFactor(input: {
	factor: number;
	regionFactor: number | null;
	band?: number;
}): GuardedFactor {
	const band = input.band ?? INDEX_FACTOR_BAND;
	const factor = input.factor;
	const regionFactor = input.regionFactor;
	if (
		!Number.isFinite(factor) ||
		factor <= 0 ||
		regionFactor == null ||
		!Number.isFinite(regionFactor) ||
		regionFactor <= 0
	) {
		return { factor, replaced: false };
	}
	const ratio = factor / regionFactor;
	if (ratio > band || ratio < 1 / band) {
		return { factor: regionFactor, replaced: true };
	}
	return { factor, replaced: false };
}

/* ------------------------------------------------------------------ *
 * Implausible-discount guard
 * ------------------------------------------------------------------ */

/**
 * A discount this large is almost always a broken comp set, not a bargain
 * (live: a 120k village plot "94% below" a 2.07M estimate, a 156 m²
 * industrial plot at 85%). Court auctions legitimately sit 30-45% below, so
 * the guard starts above them and only asks for a broad, tight comp set:
 * at least `DISCOUNT_GUARD.minComps` comps and an interquartile spread no
 * wider than `DISCOUNT_GUARD.maxIqrRatio` of the fair value.
 */
export const DISCOUNT_GUARD = {
	discountPct: 45,
	minComps: 5,
	maxIqrRatio: 0.8,
} as const;

export interface DiscountGuardResult {
	/** Implied discount vs fair value, percent (negative = below fair). */
	discountPct: number | null;
	implausible: boolean;
	reason: string | null;
}

export function implausibleDiscount(input: {
	offerM2: number | null;
	fairM2: number;
	compCount: number;
	p25M2: number;
	p75M2: number;
}): DiscountGuardResult {
	if (
		input.offerM2 == null ||
		!Number.isFinite(input.offerM2) ||
		input.offerM2 <= 0 ||
		!(input.fairM2 > 0)
	) {
		return { discountPct: null, implausible: false, reason: null };
	}
	const discountPct = (input.offerM2 / input.fairM2 - 1) * 100;
	if (discountPct > -DISCOUNT_GUARD.discountPct) {
		return { discountPct, implausible: false, reason: null };
	}
	const iqrRatio =
		input.fairM2 > 0
			? (Math.max(input.p75M2, input.fairM2) -
					Math.min(input.p25M2, input.fairM2)) /
				input.fairM2
			: Number.POSITIVE_INFINITY;
	if (input.compCount < DISCOUNT_GUARD.minComps) {
		return { discountPct, implausible: true, reason: "discount_few_comps" };
	}
	if (iqrRatio > DISCOUNT_GUARD.maxIqrRatio) {
		return { discountPct, implausible: true, reason: "discount_wide_spread" };
	}
	return { discountPct, implausible: false, reason: null };
}
