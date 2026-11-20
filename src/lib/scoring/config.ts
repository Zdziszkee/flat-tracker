/**
 * Versioned constants for the transparent alert score.
 *
 * Every number that can change a stored score is a policy choice, not a
 * learned parameter, and changing it requires a new `SCORE_VERSION` so stored
 * scores stay auditable. Selection-only rules (how many alerts are kept) are
 * documented separately and do not change a score.
 */

import { clamp } from "#/lib/stats";

export const SCORE_VERSION = "2027.22";

/** Minimum score components for an offer to enter the alert list. */
export const ALERT_GATES = {
	minValueScore: 55,
	minConfidence: 0.5,
	/** Asking price must be at least this far below the local comparable median. */
	minDiscountPct: 10,
	/**
	 * A discount this large is evidence against the comparable set, not for the
	 * offer. The live list carried a 1000 m² village plot "94% below median"
	 * (120k asking, 2.07M "fair") and a 156 m² industrial plot at 85%: both
	 * were land compared with central building plots because the listing
	 * coordinates were a city-centre placeholder. A real offer rarely clears
	 * half the local median; a court auction starts around 25-45% below, which
	 * this ceiling still admits.
	 */
	maxDiscountPct: 55,
	/**
	 * Between `unverifiedDiscountPct` and `maxDiscountPct` the discount must be
	 * carried by a broad and tight comp set, otherwise it is a mispriced
	 * estimate (Torfowa 57 m² scored 33.5% below on a fair value of
	 * 18 454 zł/m² in Ruczaj, where the market trades nearer 13-14k).
	 */
	unverifiedDiscountPct: 35,
	unverifiedDiscountMinComps: 15,
	unverifiedDiscountMaxSpreadPct: 25,
	/**
	 * Plausibility band for the median index factor that brings the comps to
	 * today. Nominal prices in the tracked regions grew roughly 25-35% between
	 * 2020 and 2026, so a median factor near x5 (a 2021-Q4 comp in Bielsko-Biała
	 * scored x5.07) or a factor below the region series (x0.85 on a three-year
	 * Katowice span, where the region series rose) is a thin-cell series
	 * artifact, not market movement. The lower bound sits at 0.9 because a
	 * median which says the comps fell while the region rose cannot come from
	 * a healthy cell; the deepest real dip in the tracked market was under 10%
	 * and only for two quarters. When
	 * the median factor leaves this band the fair value is fiction. The band is
	 * wide on purpose: it catches broken series only, not price growth.
	 */
	minIndexFactor: 0.9,
	maxIndexFactor: 1.6,
	/** Above this the factor is suspicious but not yet disqualifying. */
	highIndexFactor: 1.35,
} as const;

/**
 * Size of the daily leaderboard: the best `ALERT_TOP_OFFERS` offers per
 * segment (flats, houses, plots) across the tracked regions. This replaced
 * the old top-5%-of-the-pool cut so the /alerts page shows a stable, readable
 * number of offers per category instead of a number that grows with the pool.
 *
 * This is a selection rule, not a scoring rule: it changes which scored
 * offers become alerts, never a stored score, so it does not require a
 * `SCORE_VERSION` bump. The value is recorded on each alert it creates
 * (`payload_json.cut`), which keeps old rows auditable after a rule change.
 */
export const ALERT_TOP_OFFERS = 25;

/**
 * How many units of one investment (osiedle, developer, one address) may fill
 * a segment's leaderboard. A developer price list is not 25 opportunities:
 * today's flat list carried five units of "Apartamenty Park Matecznego" and six
 * of "Stańczyka II", so half a column was one building. Selection only, never
 * a score, so it does not require a `SCORE_VERSION` bump.
 */
export const ALERT_MAX_PER_INVESTMENT = 2;

/**
 * Additive amenity boosts, applied AFTER the weighted components.
 *
 * The five components are 0-100 each and average a strong location signal
 * away: a flat next to a tram stop, in a municipal-heating block, can score
 * barely above one with gas heating and a 600 m walk. Each boost below is a
 * separate named reason, so the alert card shows exactly why the offer
 * gained points. Values are points on the final 0-100 score, deliberately
 * small: a fully served flat gains 24, not a tier reset.
 */
export const AMENITY_BONUSES = {
	/** District heating (miejskie) or a heat pump. */
	districtHeating: 5,
	/** A tram stop inside `AMENITY_BONUS_RANGE.tramM`. */
	tramStop: 5,
	/** A railway station inside `AMENITY_BONUS_RANGE.stationM`. */
	railStation: 5,
	/** A park inside `AMENITY_BONUS_RANGE.parkM`. */
	park: 3,
	/** Water inside `AMENITY_BONUS_RANGE.waterM`. */
	water: 2,
	elevator: 2,
	parking: 2,
	/** House-only holiday bonuses: lake/river, forest, mountains, solitude. */
	holidayWater: 8,
	holidayForest: 6,
	holidayMountains: 4,
	holidayIsolation: 6,
	/** A park or national park around the house. */
	holidayPark: 5,
	/** Nothing else stands within `HOUSE_UNIQUENESS.wildernessM`. */
	holidayWilderness: 8,
} as const;

/** Distance ceilings for the additive amenities, in metres. */
export const AMENITY_BONUS_RANGE = {
	tramM: 300,
	stationM: 1000,
	parkM: 300,
	waterM: 500,
} as const;

/**
 * Plot green/water tiers. A forest or lake on the same parcel (or directly
 * adjacent, approximated by the parcel radius plus a margin) is worth three
 * times the base amenity value; the same feature within
 * `PLOT_GREEN_RANGE_M` is worth a third. Beyond the range nothing is
 * granted, so a distant lake cannot leak into the score.
 */
export const PLOT_GREEN = {
	adjacentMarginM: 20,
	rangeM: 3000,
	nearMultiplier: 3,
	farDivisor: 3,
} as const;

/**
 * Alert eligibility by segment. These are hard filters, not score penalties:
 * an offer that fails one is still scored and kept in the table, but it can
 * never enter the leaderboard. Unknown values are excluded too, because the
 * rule is "prove the quality", not "punish a wrong value".
 */
export const SEGMENT_ELIGIBILITY = {
	/** Flats must be district-heated (or a heat pump) and not a large-panel block. */
	flatRequiresDistrictHeating: true,
	/**
	 * Flats may not sit in an old block (`buildingClassOf(...).oldBlock`: a
	 * large-panel building, or a block proved to predate 2000). Tenements, new
	 * blocks, apartment buildings and blocks of unknown age stay eligible.
	 */
	flatExcludesOldBlock: true,
	/** Flats must sit inside `CENTRE_ZONE.radiusM` of a tracked city centre. */
	flatRequiresCentreZone: true,
	/** Plots must show building-plot evidence: plot type, WZ or a zoning plan. */
	plotRequiresBuildingEvidence: true,
	/**
	 * Houses are a different target: a unique holiday property that earns from
	 * short-term rentals, not spare building land. They need nature around them
	 * and character (wood, age, isolation), never a buildable-parcel proof.
	 */
	houseRequiresNature: true,
	houseRequiresCharacter: true,
	/** Plots must sit inside `FAST_RAIL.gateRadiusM` of a fast-rail station. */
	plotRequiresFastRail: true,
	/**
	 * Houses are NOT fast-rail gated: a wooden cottage by a lake 40 km from a
	 * station is exactly the target, and a suburban house next to one is not.
	 */
	houseRequiresFastRail: false,
} as const;

/**
 * The holiday-house target: an old or wooden house, alone, with water, forest
 * or mountains around it, that short-term renters pay for.
 *
 * These values feed two places: the nature/character gates (an offer that
 * shows no such evidence is kept in the table but never alerted) and the house
 * property component plus its amenity bonuses, so the ranking prefers the
 * unique property over the ordinary one.
 */
export const HOUSE_UNIQUENESS = {
	/** Water this close counts as "by the lake/river" for the gate. */
	natureWaterM: 1000,
	/** Forest this close counts as "in the woods" for the gate. */
	natureForestM: 800,
	/** A park this close is a nature setting on its own (park, national park). */
	natureParkM: 500,
	/** A building closer than this means neighbours next door. */
	closeNeighbourM: 100,
	/** Buildings within this many metres that still count as a hamlet. */
	hamletNeighbours: 4,
	/** Plot size that alone makes a property stand out, m². */
	bigPlotM2: 1500,
	/** A pre-war house is the "klimatyczny stary dom" the target is about. */
	prewarBuiltBefore: 1945,
	/** A building older than this is "retro" on its own, year. */
	retroBuiltBefore: 1980,
	/** Awarded when the nearest other building is at least this far away. */
	isolatedM: 100,
	/** Awarded when nothing else stands within `closeNeighbourM` x 2. */
	veryIsolatedM: 250,
	/** "W dziczy": nothing else within half a kilometre. */
	wildernessM: 500,
} as const;

/**
 * Short-term-rental market bonus. Nightly medians come from the stored
 * airbnb/booking rows within 2 km (`house-nature.ts`); a sample under
 * `minSample` earns nothing, so one optimistic listing cannot lift a house.
 */
export const STR_MARKET = {
	minSample: 5,
	bands: [
		[600, 6],
		[400, 4],
		[250, 2],
	] as ReadonlyArray<readonly [number, number]>,
	/**
	 * Offer density inside 2 km, from booking + airbnb. A dense cluster is the
	 * clearest evidence a holiday property in this area earns: the local
	 * distribution (dev corpus) has a median of 1, p90 19 and a max of 228, so
	 * 30/60/120 separate a busy resort from an ordinary village.
	 */
	densityBands: [
		[120, 6],
		[60, 4],
		[30, 2],
	] as ReadonlyArray<readonly [number, number]>,
} as const;

/**
 * Fast-rail access (200 km/h+ today, KDP from 2035).
 *
 * The gate is the plot segment's catchment: land has to sit in a station's
 * orbit, but the walkable ring is the *bonus* curve, not the gate. A 3 km
 * gate around the six 200 km/h+ stations (about 170 km² of a 35 000 km²
 * region) left the Działki section permanently empty: 5 of 644 live plots
 * passed it and none of those had a single comparable, so no plot could ever
 * alert. 20 km is the commute catchment a buyer would accept for land and
 * keeps 189 plots (31 with buildable evidence) in scope; the band curve
 * still rewards the 800-2000 m ring and penalises the station doorstep.
 */
export const FAST_RAIL = {
	gateRadiusM: 20_000,
	bands: [
		[400, 50],
		[800, 80],
		[1500, 100],
		[2000, 90],
		[3000, 70],
	] as DistanceBands,
	fallback: 0,
	/** Bonus points for living inside the gate radius (plots and houses). */
	bonus: 8,
	/** Extra points when the station is a planned KDP call (2035+). */
	kdpBonus: 4,
} as const;

/**
 * Centre zone for flats. Distance is measured to the nearest anchor in
 * `src/lib/scoring/centre-zone.ts` (Rynek Główny, Kazimierz, Podgórze,
 * Krowodrza, Grzegórzki, Dębniki, Zwierzyniec, Wola Justowska, Katowice
 * Rynek), not to a single city point, because the target is the walkable core
 * of a handful of neighbourhoods, not a 4 km disc around one square.
 *
 * The 4 km radius is the user's rule and is a gate, not just a score: an
 * offer outside it is kept in the table but never alerted.
 */
export const CENTRE_ZONE = {
	radiusM: 4000,
	bands: [
		[500, 100],
		[1000, 95],
		[2000, 85],
		[3000, 72],
		[4000, 55],
	] as DistanceBands,
	fallback: 0,
	/** Bonus points for a flat inside the zone (on top of the zone component). */
	bonus: 6,
	/**
	 * A tenement is the target, but a pre-war building is the same asset class
	 * even when the ad calls it "kamienica" or the portal labels it
	 * "apartment": both count as tenement evidence.
	 */
	tenementMaxBuildYear: 1945,
} as const;

/**
 * Headroom scale for the additive amenities, in score points. A bonus is
 * multiplied by `min(1, (100 - weighted) / SCALE)`, so a 90-point offer
 * still gains from a tram stop without every top candidate collapsing into
 * the same 100. The scale is larger than the bonus budget (24), which keeps
 * the final score strictly increasing in the weighted components.
 */
export const AMENITY_HEADROOM_SCALE = 30;

/**
 * Fresh-arrival alerts. A newly saved offer is scored immediately and
 * appended to today's list when its total score sits inside the top
 * `topPercent` of the offers first seen in the last `windowHours`, in the
 * same region and segment. This is an additional rule, not a replacement:
 * the market-wide top-5% cut still runs after every refresh, so a fresh
 * offer that misses its 24-hour cohort can still enter through the full
 * pool. The window is measured on `coalesce(firstSeenAt, listedAt,
 * scrapedAt)`, so a portal posting date never drags an old offer into a
 * cohort. A cut always keeps at least one position: a lone arrival is its
 * own cohort leader.
 */
export const ALERT_FRESHNESS = {
	windowHours: 24,
	topPercent: 5,
} as const;

/**
 * Position of `score` in a cohort, 1 = best. Ties do not count as beaten:
 * an offer shares the rank of every equal score, which keeps the rule
 * conservative (a tie at the cut does not displace the incumbents).
 */
export function freshArrivalRank(
	score: number,
	cohortScores: readonly number[],
): number {
	let rank = 1;
	for (const other of cohortScores) {
		if (other > score) rank++;
	}
	return rank;
}

/** How many cohort positions the top `topPercent` cut keeps (at least one). */
export function freshArrivalTopN(
	cohortSize: number,
	topPercent: number = ALERT_FRESHNESS.topPercent,
): number {
	if (cohortSize <= 0 || topPercent <= 0) return 0;
	return Math.max(1, Math.ceil((cohortSize * topPercent) / 100));
}

/**
 * Whether a fresh arrival belongs in today's alerts: inside the top
 * `topPercent` of its cohort. An empty cohort alerts nothing (there is no
 * field to beat); a single-offer cohort is its own leader.
 */
export function shouldAlertFreshArrival(
	score: number,
	cohortScores: readonly number[],
	topPercent: number = ALERT_FRESHNESS.topPercent,
): boolean {
	if (cohortScores.length === 0) return false;
	return (
		freshArrivalRank(score, cohortScores) <=
		freshArrivalTopN(cohortScores.length, topPercent)
	);
}

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
	// Price carries less weight than before: a 30% swing in asking price is
	// common, so location, building quality and risk must decide more of the
	// ranking. Flats: the target is a centre-zone tenement with municipal
	// heating, so the property component (building style, condition) and the
	// transit component (tram, centre zone) outrank the discount.
	flat: { value: 0.3, transit: 0.2, green: 0.2, property: 0.25, risk: 0.05 },
	// Houses: the property itself (character, solitude) and its surroundings are
	// the product, so green and property carry the ranking and transit drops to
	// a secondary signal (a holiday house is not bought for a tram).
	house: { value: 0.3, transit: 0.1, green: 0.3, property: 0.25, risk: 0.05 },
	plot: { value: 0.25, transit: 0.15, green: 0.28, property: 0.27, risk: 0.05 },
};

/**
 * Flat building-style preferences, applied once from `building_type`,
 * `building_material` or the offer text. Large-panel blocks lose points;
 * tenements and purpose-built apartment buildings gain them. A structured
 * value always wins over free text, so a title mentioning a nearby block
 * cannot override the portal's building type.
 */
export const FLAT_BUILDING_DELTAS = {
	largePanel: -12,
	tenement: 10,
	apartmentBuilding: 8,
	brick: 4,
	concrete: 3,
	wood: 2,
} as const;

/**
 * Heating costs used by the flat and house property components. District
 * heating is rewarded; gas is penalized as the more expensive fuel and
 * electric resistive heating as the most expensive one. The Polish portal
 * values (`miejskie`, `gazowe`, `elektryczne`) and their English equivalents
 * are both recognised at the scoring boundary.
 */
export const HEATING_DELTAS = {
	heatPump: 8,
	district: 8,
	gas: -7,
	electric: -12,
	coalWood: -10,
	oil: -7,
} as const;

/** Distance bands in metres. First band that contains the distance wins. */
export type DistanceBands = ReadonlyArray<readonly [number, number]>;

/**
 * Tram is a flat-only signal and only in the two cities with tram networks in
 * the tracked regions. `city` comes from the listing's structured city field,
 * normalized at the scoring boundary; `geo.city` is only the nearest external
 * price-index centre and labels the whole region, so it must not be used here.
 * The 300 m target is the full-credit band: a stop within 300 m is close enough
 * that a few dozen metres make no practical difference.
 */
export const TRAM_CITIES = ["krakow", "katowice"] as const;
export const TRAM_TARGET_M = 300;
export const TRAM_BANDS: DistanceBands = [
	[TRAM_TARGET_M, 100],
	[600, 80],
	[1000, 60],
	[1500, 40],
	[3000, 15],
];
export const TRAM_FALLBACK = 20;

/**
 * A station 300-800 m away is the sweet spot: close enough to walk, far
 * enough to avoid the noise and grime of a station at the doorstep. The
 * preference continues to 2 km, then decays. Houses and plots give this
 * distance most of the transit component because they are not tram markets.
 */
export const TRAIN_PREFERRED_M = 2000;
export const TRAIN_STATION_BANDS: DistanceBands = [
	[150, 40],
	[300, 70],
	[800, 100],
	[TRAIN_PREFERRED_M, 85],
	[3000, 55],
	[5000, 30],
];
export const TRAIN_FALLBACK = 15;

/**
 * How the transit component is composed. A signal that does not apply to a
 * listing gets zero weight, and that weight is moved to the signals that do,
 * so an inapplicable tram stop can never raise a house score and a missing
 * tram network cannot silently drain the flat score outside tram cities.
 *
 * `fastRail` is the 200 km/h+/KDP access signal and carries most of the house
 * and plot transit score: for those two segments the nearest fast-rail station
 * is the reason the offer is on the list at all. `center` for flats is the
 * centre-zone band (`CENTRE_ZONE`), not the external city-centre label.
 */
export const TRANSIT_MIX = {
	flatTram: { tram: 0.45, train: 0.15, bus: 0.1, center: 0.3, fastRail: 0 },
	flatNoTram: { tram: 0, train: 0.4, bus: 0.15, center: 0.45, fastRail: 0 },
	housePlot: { tram: 0, train: 0.25, bus: 0.1, center: 0.15, fastRail: 0.5 },
} as const;

export const DISTANCE_BANDS = {
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
