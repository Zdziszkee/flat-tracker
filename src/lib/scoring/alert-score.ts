/**
 * Deterministic, explainable alert score.
 *
 * The score is a weighted sum of five 0-100 components. It never calls an ML
 * model. Every component is monotonic in the signal it represents: a larger
 * discount, a closer tram stop, more forest cover, or a lower risk flag can
 * never reduce that component.
 */

import { buildingClassOf } from "#/lib/building-class";
import type { ScoredFacts } from "#/lib/llm/fact-access";
import { buildingStyleFromProse } from "#/lib/scoring/prose-lexicon";
import { clamp } from "#/lib/stats";
import type { GeoUniqueness } from "#/lib/valuation/uniqueness-geo";
import { textUniqueness } from "#/lib/valuation/uniqueness-text";
import type { ValuationEstimate } from "#/types/listing";
import { centreLabel, nearestCentreAnchor } from "./centre-zone";
import {
	ALERT_GATES,
	type AlertSegment,
	AMENITY_BONUS_RANGE,
	AMENITY_BONUSES,
	AMENITY_HEADROOM_SCALE,
	CENTRE_ZONE,
	DISTANCE_BANDS,
	distanceScore,
	ESTIMATE_CONFIDENCE,
	FAST_RAIL,
	FLAT_BUILDING_DELTAS,
	HOUSE_UNIQUENESS,
	PLOT_GREEN,
	PLOT_LISTING_BASE_CONFIDENCE,
	PLOT_LISTING_RCN_FACTOR,
	PLOT_SPREAD_FACTOR_FLOOR,
	SCORE_VERSION,
	SEGMENT_ELIGIBILITY,
	SEGMENT_WEIGHTS,
	STR_MARKET,
	TRAIN_FALLBACK,
	TRAIN_PREFERRED_M,
	TRAIN_STATION_BANDS,
	TRAM_BANDS,
	TRAM_CITIES,
	TRAM_FALLBACK,
	TRAM_TARGET_M,
	TRANSIT_MIX,
	valueCurveScore,
} from "./config";
import { fastRailLabel, nearestFastRail } from "./fast-rail";
import { type HeatingEvidence, resolveHeatingEvidence } from "./heating";
import type { Neighbourhood, StrMarket } from "./house-nature";

export interface ScoreParcelFeatures {
	areaM2?: number | null;
	frontageM?: number | null;
	roadDistanceM?: number | null;
	roadClass?: string | null;
	buildingCoverage?: number | null;
	/** Buildings already standing on the parcel (EGiB / OSM count). */
	buildingCount?: number | null;
	landUseClass?: string | null;
	zoningWz?: boolean | null;
	zoningNoPlan?: boolean | null;
	zoningPlanCount?: number | null;
	floodRisk?: boolean | null;
	slopeDeg?: number | null;
	elevationM?: number | null;
}

export interface ScoreListingInput {
	id: number;
	source: string;
	segment: AlertSegment;
	region: string;
	city?: string | null;
	title: string;
	description?: string | null;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	plotAreaM2?: number | null;
	rooms?: number | null;
	floor?: string | null;
	floorCount?: number | null;
	buildYear?: number | null;
	buildingMaterial?: string | null;
	condition?: string | null;
	ownership?: string | null;
	heatingType?: string | null;
	/** Portal attribute blob value (`features.heating`), often a short code. */
	featuresHeating?: string | null;
	buildingType?: string | null;
	plotType?: string | null;
	market?: string | null;
	hasBalcony?: boolean | null;
	hasTerrace?: boolean | null;
	hasGarden?: boolean | null;
	hasElevator?: boolean | null;
	hasParking?: boolean | null;
	hasGarage?: boolean | null;
	hasBasement?: boolean | null;
	auctionType?: string | null;
	lat?: number | null;
	lng?: number | null;
	parcelFeatures?: ScoreParcelFeatures | null;
	/**
	 * Facts the LLM read out of the title and description (prompt v2). This is
	 * the only prose channel: heating, building style, tenement evidence, plot
	 * zoning/media and the setting around a plot all come from here instead of
	 * regexes over the ad text.
	 */
	facts?: ScoredFacts | null;
	/** Other buildings around a house, from the OSM footprint index. */
	neighbours?: Neighbourhood | null;
	/** Short-term-rental market around a house (airbnb/booking rows). */
	str?: StrMarket | null;
	/**
	 * Coordinates are a bulk-source placeholder (a city centre shared by dozens
	 * of street-less listings), so every distance in the score is fiction. Set
	 * by `run.ts` from `placeholder-points.ts`.
	 */
	placeholderCoordinates?: boolean;
}

export interface ScoreReason {
	label: string;
	impact: number;
	direction: "positive" | "negative";
}

export interface AlertScore {
	scoreVersion: string;
	segment: AlertSegment;
	region: string;
	valueScore: number;
	transitScore: number;
	greenScore: number;
	propertyScore: number;
	riskScore: number;
	totalScore: number;
	confidence: number;
	discountPct: number | null;
	fairPrice: number | null;
	fairM2: number | null;
	askingPrice: number | null;
	/** Comparables behind the valuation median; 0 when not recorded. */
	compCount: number;
	/** RCN transactions among those comparables. */
	compRcnCount: number;
	eligible: boolean;
	/** Passes every gate except `no_heating_evidence`; fills a short section. */
	fallbackEligible: boolean;
	gateReason: string | null;
	reasons: ScoreReason[];
	flags: string[];
	amenities: GeoUniqueness | null;
	/**
	 * Evidence behind the fair value: the condition/quality correction and the
	 * comparable statistics. Stored with the score so the alert card can show
	 * *why* the median moved instead of only the resulting number.
	 */
	valuation: ScoreValuation | null;
}

/** Comparables kept with a score: enough to audit, small enough for the feed. */
const COMPARABLES_STORED = 30;

/** The estimate evidence a stored score keeps for the card. */
export interface ScoreValuation {
	/** Condition/quality correction applied to the comp median, percent. */
	qualityPct: number;
	/** False when no facts were available, so the correction is neutral. */
	qualityKnown: boolean;
	qualityReasons: Array<{ code: string; label: string; pct: number }>;
	/**
	 * The comparables the median was built from, strongest first. Stored with
	 * the score so the alert card can expand "Wycena z N ofert" into the list
	 * instead of re-running the valuation.
	 */
	comparables: Array<{
		id: string;
		source: "rcn" | "listing";
		date: string | null;
		distanceM: number | null;
		areaM2: number | null;
		rooms: number | null;
		address: string | null;
		priceM2: number;
		adjustedPriceM2: number;
		timeFactor: number;
		askingRatio: number | null;
	}>;
	/** Median index factor that brought the comps to today. */
	timeFactorMedian: number | null;
	indexSpan: { from: string; to: string } | null;
	askingRatio: number | null;
	askingRatioSource: "measured" | "fallback" | null;
	compAgeMedianYears: number | null;
}

function scoreValuation(
	estimate: ValuationEstimate | null,
): ScoreValuation | null {
	if (estimate == null) return null;
	return {
		qualityPct: estimate.qualityAdjustmentPct,
		qualityKnown: estimate.qualityAdjustmentKnown,
		qualityReasons: estimate.qualityAdjustmentReasons.map((reason) => ({
			code: reason.code,
			label: reason.label,
			pct: reason.pct,
		})),
		comparables: estimate.comparables
			.slice(0, COMPARABLES_STORED)
			.map((comp) => ({
				id: comp.id,
				source: comp.source,
				date: comp.date,
				distanceM: comp.distanceM == null ? null : Math.round(comp.distanceM),
				areaM2: comp.areaM2,
				rooms: comp.rooms,
				address: comp.address,
				priceM2: Math.round(comp.originalPriceM2),
				adjustedPriceM2: Math.round(comp.adjustedPriceM2),
				timeFactor: Math.round(comp.timeFactor * 1000) / 1000,
				askingRatio: comp.askingRatio ?? null,
			})),
		timeFactorMedian: estimate.statistics.timeFactorMedian,
		indexSpan: estimate.statistics.indexSpan,
		askingRatio: estimate.statistics.askingRatio,
		askingRatioSource: estimate.statistics.askingRatioSource,
		compAgeMedianYears: estimate.statistics.compAgeMedianYears,
	};
}

interface Component {
	score: number;
	confidence: number;
	reasons: Array<{ label: string; impact: number }>;
	flags?: string[];
}

function floorNumber(floor: string | null | undefined): number | null {
	if (!floor) return null;
	const text = floor.toLowerCase();
	if (text === "ground_floor" || text === "parter") return 0;
	if (text === "basement" || text === "suterena") return -1;
	const match = text.match(/(-?\d+)/u);
	return match?.[1] ? Number(match[1]) : null;
}

function valueComponent(
	input: ScoreListingInput,
	estimate: ValuationEstimate | null,
): Component {
	const asking = input.price;
	const fair = estimate?.fairPrice ?? null;
	if (asking == null || asking <= 0 || fair == null || fair <= 0) {
		return {
			score: 40,
			confidence: 0.15,
			reasons: [],
			flags: ["no_comparable_estimate"],
		};
	}
	const rcnCount = estimate?.confidence.rcnCount ?? 0;
	const rawDiscount = 1 - asking / fair;
	// Anchored, saturating curve on the raw discount below the local
	// comparable median (VALUE_CURVE): 0% -> 50, 10% -> 80, 20% -> 95,
	// 30%+ -> 100 cap. Same curve for RCN and listing-only comps. No
	// negotiation margin is applied: the comparables already carry the
	// asking-vs-transaction wedge (RCN comps are time-adjusted transactions,
	// listing comps are asking prices like the offer itself), so adding a
	// margin would double-count it.
	const score = clamp(valueCurveScore(rawDiscount), 0, 100);
	const reasons: Array<{ label: string; impact: number }> = [];
	if (rawDiscount >= 0.03) {
		reasons.push({
			label: `${Math.round(rawDiscount * 100)}% cheaper than the local comparable median`,
			impact: Math.min(35, rawDiscount * 100),
		});
	} else if (rawDiscount <= -0.03) {
		reasons.push({
			label: `${Math.round(Math.abs(rawDiscount) * 100)}% above the local comparable median`,
			impact: -Math.min(35, Math.abs(rawDiscount) * 100),
		});
	}
	const level = estimate?.confidence.level ?? "low";
	const isPlot = input.segment === "plot";
	const listingOnly = rcnCount < 3;
	// Plots get a listing-only base instead of the RCN-oriented level: the
	// offer-model level caps every RCN-less set at "low" (0.45), which with
	// the plot segment weights made the 0.5 confidence gate unreachable
	// even for a dense, tight local land comp set. See config.ts for the
	// policy rationale; RCN-backed plot sets keep the reported level.
	const baseConfidence =
		isPlot && listingOnly
			? PLOT_LISTING_BASE_CONFIDENCE
			: (ESTIMATE_CONFIDENCE[level] ?? 0.45);
	const count = estimate?.confidence.totalCount ?? 0;
	const countFactor = clamp((count - 2) / 18, 0.2, 1);
	const spread = estimate?.confidence.spreadPct ?? 100;
	const rawSpreadFactor =
		spread <= 10 ? 1 : spread >= 40 ? 0.45 : 1 - (spread - 10) / 60;
	// Land comp sets mix building/agricultural/recreational plots, so their
	// spread is structurally wider without the median being less usable;
	// floor the decay for plots (the wide_comp_spread risk flag stays).
	const spreadFactor = isPlot
		? Math.max(rawSpreadFactor, PLOT_SPREAD_FACTOR_FLOOR)
		: rawSpreadFactor;
	// Listing-only comparables are asking prices like the offer itself, so
	// they support the discount comparison at reduced trust. The old 0.55
	// factor capped the value confidence at 0.45 * 0.55 < 0.25, which made
	// the 0.5 alert gate unreachable for every offer before the RCN import
	// lands (fresh clone, new region).
	const rcnFactor = listingOnly ? (isPlot ? PLOT_LISTING_RCN_FACTOR : 0.85) : 1;
	const confidence = clamp(
		baseConfidence * countFactor * spreadFactor * rcnFactor,
		0.05,
		1,
	);
	return {
		score,
		confidence,
		reasons,
		flags: [
			...(count < 5 ? ["few_comparables"] : []),
			...(rcnCount < 3 ? ["listing_only_comps"] : []),
		],
	};
}

/** Listing city values are native Polish names with a few case/ASCII variants. */
function normalizedCity(city: string | null | undefined): string {
	return (city ?? "")
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.trim();
}

function inTramCity(city: string | null | undefined): boolean {
	const normalized = normalizedCity(city);
	return (
		TRAM_CITIES.some((tramCity) => tramCity === normalized) ||
		normalized.startsWith("katowice ")
	);
}

function transitComponent(
	input: ScoreListingInput,
	geo: GeoUniqueness | null,
): Component {
	if (!geo) {
		return {
			score: 45,
			confidence: 0.2,
			reasons: [],
			flags: ["missing_coordinates"],
		};
	}
	const tramFlat = input.segment === "flat" && inTramCity(input.city);
	const mix = tramFlat
		? TRANSIT_MIX.flatTram
		: input.segment === "flat"
			? TRANSIT_MIX.flatNoTram
			: TRANSIT_MIX.housePlot;
	const tram = tramFlat
		? distanceScore(geo.tramM, TRAM_BANDS, TRAM_FALLBACK)
		: 0;
	const train = distanceScore(
		geo.trainStationM,
		TRAIN_STATION_BANDS,
		TRAIN_FALLBACK,
	);
	const bus = distanceScore(geo.busM, DISTANCE_BANDS.bus);
	// Flats measure the walkable core against the anchor set; houses and plots
	// measure fast-rail access instead (the reason they are on the list).
	const zoneMatch =
		input.segment === "flat"
			? nearestCentreAnchor(input.lat, input.lng, input.city)
			: null;
	const centre =
		zoneMatch != null
			? distanceScore(
					zoneMatch.distanceM,
					CENTRE_ZONE.bands,
					CENTRE_ZONE.fallback,
				)
			: distanceScore(geo.centerM, DISTANCE_BANDS.center);
	const railMatch =
		input.segment === "flat" ? null : nearestFastRail(input.lat, input.lng);
	const fastRail =
		railMatch != null
			? distanceScore(railMatch.distanceM, FAST_RAIL.bands, FAST_RAIL.fallback)
			: 0;
	let score =
		tram * mix.tram +
		train * mix.train +
		bus * mix.bus +
		centre * mix.center +
		fastRail * mix.fastRail;
	const reasons: Array<{ label: string; impact: number }> = [];
	const flags: string[] = [];
	if (tramFlat && geo.tramM != null && geo.tramM <= TRAM_TARGET_M) {
		reasons.push({
			label: `${Math.round(geo.tramM)} m to the nearest tram stop (300 m target)`,
			impact: 8,
		});
	} else if (tramFlat && geo.tramM != null && geo.tramM <= 600) {
		reasons.push({
			label: `${Math.round(geo.tramM)} m to the nearest tram stop`,
			impact: 4,
		});
	}
	if (
		geo.trainStationM != null &&
		geo.trainStationM >= 300 &&
		geo.trainStationM < TRAIN_PREFERRED_M
	) {
		reasons.push({
			label: `${(geo.trainStationM / 1000).toFixed(1)} km to a railway station`,
			impact: 8,
		});
	}
	if (zoneMatch != null && zoneMatch.distanceM <= CENTRE_ZONE.radiusM) {
		reasons.push({
			label: centreLabel(zoneMatch),
			impact: zoneMatch.distanceM <= 1000 ? 10 : 6,
		});
	} else if (geo.centerM != null && geo.centerM <= 2500) {
		reasons.push({
			label: `${(geo.centerM / 1000).toFixed(1)} km to the city centre`,
			impact: 6,
		});
	}
	if (railMatch != null && railMatch.distanceM <= FAST_RAIL.gateRadiusM) {
		reasons.push({
			label: `${railMatch.kdpPlanned ? "KDP" : "kolej 200+ "}${fastRailLabel(railMatch)}`,
			impact: railMatch.kdpPlanned ? 10 : 7,
		});
	}
	if (geo.railM != null) {
		if (geo.railM < 100) {
			score -= 20;
			flags.push("rail_noise");
			reasons.push({ label: "railway line within 100 m", impact: -12 });
		} else if (geo.railM < 200) {
			score -= 12;
			flags.push("rail_noise");
			reasons.push({ label: "railway line within 200 m", impact: -8 });
		} else if (geo.railM < 400) {
			score -= 5;
			reasons.push({ label: "railway line within 400 m", impact: -4 });
		}
	}
	return { score: clamp(score, 0, 100), confidence: 0.85, reasons, flags };
}

function greenComponent(geo: GeoUniqueness | null): Component {
	if (!geo) {
		return {
			score: 45,
			confidence: 0.2,
			reasons: [],
			flags: ["missing_coordinates"],
		};
	}
	const park = distanceScore(geo.parkM, DISTANCE_BANDS.park);
	const forestDistance = distanceScore(geo.forestM, DISTANCE_BANDS.forest);
	const forestShare = clamp((geo.forestShare500m ?? 0) * 100, 0, 100);
	const forest = forestDistance * 0.65 + forestShare * 0.35;
	const waterDistance = Math.max(
		distanceScore(geo.lakeM, DISTANCE_BANDS.water),
		distanceScore(geo.riverM, DISTANCE_BANDS.water),
	);
	const water = clamp(
		waterDistance + Math.min(10, (geo.waterShare1000m ?? 0) * 25),
		0,
		100,
	);
	const parkBonus = Math.min(8, (geo.parkCount500m ?? 0) * 4);
	const score = park * 0.3 + forest * 0.35 + water * 0.35 + parkBonus;
	const reasons: Array<{ label: string; impact: number }> = [];
	if (geo.parkM != null && geo.parkM <= 600) {
		reasons.push({ label: `${Math.round(geo.parkM)} m to a park`, impact: 8 });
	}
	if (geo.parkCount500m > 0) {
		reasons.push({
			label: `${geo.parkCount500m} park${geo.parkCount500m === 1 ? "" : "s"} within 500 m`,
			impact: Math.min(6, geo.parkCount500m * 3),
		});
	}
	if (geo.forestM != null && geo.forestM <= 600) {
		reasons.push({
			label: `${Math.round(geo.forestM)} m to forest`,
			impact: 8,
		});
	}
	if (geo.forestShare500m >= 0.4) {
		reasons.push({
			label: `forest covers about ${Math.round(geo.forestShare500m * 100)}% of the 500 m area`,
			impact: 10,
		});
	}
	const waterM = Math.min(
		geo.lakeM ?? Number.POSITIVE_INFINITY,
		geo.riverM ?? Number.POSITIVE_INFINITY,
	);
	if (Number.isFinite(waterM) && waterM <= 600) {
		reasons.push({ label: `${Math.round(waterM)} m to water`, impact: 8 });
	}
	if (geo.waterShare1000m >= 0.15) {
		reasons.push({
			label: `water covers about ${Math.round(geo.waterShare1000m * 100)}% of the 1 km area`,
			impact: 6,
		});
	}
	return { score: clamp(score, 0, 100), confidence: 0.8, reasons };
}

/**
 * Structured values are normalized by the crawler (`block`, `apartment`,
 * `tenement`, `concrete_plate`, `brick`, ...), but older rows and a few feeds
 * still carry raw Polish strings. Accept both spellings at the scoring
 * boundary so the rule works on the whole stored pool.
 */
type FlatBuildingStyle = keyof typeof FLAT_BUILDING_DELTAS;

function flatBuildingStyle(input: ScoreListingInput): {
	style: FlatBuildingStyle;
	label: string;
} | null {
	// The LLM read of the ad text comes first: portals label almost every
	// Kraków flat "apartament" or "blok", while the description says kamienica.
	const factStyle = input.facts?.buildingStyle ?? null;
	if (factStyle === "tenement")
		return { style: "tenement", label: "kamienica" };
	if (factStyle === "largePanel") {
		return { style: "largePanel", label: "wielka płyta" };
	}
	if (factStyle === "apartment") {
		return { style: "apartmentBuilding", label: "apartamentowiec" };
	}
	if (factStyle === "block") return { style: "concrete", label: "blok" };
	const type = (input.buildingType ?? "").toLowerCase();
	const material = (input.buildingMaterial ?? "").toLowerCase();
	const structured = `${type} ${material}`;
	if (
		/wielka[ _-]?p[ył]yta|wielkopłyta|concrete[ _-]?plate|large[ _-]?panel|blok(?:u|i|ów)?\b|\bblock\b/u.test(
			structured,
		)
	) {
		return { style: "largePanel", label: "blok / wielka płyta" };
	}
	if (/kamienic|tenement/u.test(structured)) {
		return { style: "tenement", label: "kamienica" };
	}
	if (/apartamentowiec|apartment/u.test(structured)) {
		return { style: "apartmentBuilding", label: "apartamentowiec" };
	}
	if (/cegł|brick/u.test(material)) {
		return { style: "brick", label: "cegła" };
	}
	if (/beton|concrete/u.test(material)) {
		return { style: "concrete", label: "beton" };
	}
	if (/drewno|wood/u.test(material)) {
		return { style: "wood", label: "drewno" };
	}
	return null;
}

function conditionDelta(condition: string | null | undefined): number {
	const value = condition?.toLowerCase() ?? "";
	if (["excellent", "new", "very_good"].includes(value)) return 8;
	if (value === "good") return 4;
	if (
		[
			"to_renovation",
			"for_renovation",
			"to_renovate",
			"poor",
			"not_good",
		].includes(value)
	)
		return -8;
	return 0;
}

function materialDelta(material: string | null | undefined): number {
	const value = material?.toLowerCase() ?? "";
	if (
		/wielka[ _-]?p[ył]yta|wielkopłyta|concrete[ _-]?plate|large[ _-]?panel/u.test(
			value,
		)
	)
		return -12;
	if (/cegł|brick/u.test(value)) return 4;
	if (/beton|concrete/u.test(value)) return 3;
	if (/kamienic|tenement/u.test(value)) return 2;
	if (/drewno|wood/u.test(value)) return 2;
	return 0;
}

function heatingEvidence(input: ScoreListingInput): HeatingEvidence {
	return resolveHeatingEvidence({
		heatingType: input.heatingType,
		featuresHeating: input.featuresHeating,
		factsHeating: input.facts?.heating ?? null,
		prose: `${input.title}\n${input.description ?? ""}`,
	});
}

function ownershipDelta(ownership: string | null | undefined): number {
	const value = ownership?.toLowerCase() ?? "";
	if (value === "full_ownership") return 4;
	if (value === "leasehold") return -8;
	if (value === "share") return -8;
	return 0;
}

function yearDelta(year: number | null | undefined): number {
	if (year == null) return 0;
	if (year >= 2015) return 8;
	if (year >= 2000) return 5;
	if (year >= 1980) return 1;
	if (year >= 1960) return -2;
	return -4;
}

function flatProperty(input: ScoreListingInput): Component {
	let score = 60;
	const reasons: Array<{ label: string; impact: number }> = [];
	const floor = floorNumber(input.floor);
	if (floor != null) {
		if (floor < 0) score -= 25;
		else if (floor === 0) score -= input.hasGarden || input.hasTerrace ? 2 : 8;
		else if (floor <= 3) score += 6;
		else if (floor <= 6) score += input.hasElevator ? 3 : -3;
		else score += input.hasElevator ? 3 : -10;
	}
	const year = yearDelta(input.buildYear);
	score += year;
	if (year >= 5) reasons.push({ label: "newer building", impact: year });
	const building = flatBuildingStyle(input);
	if (building) {
		const delta =
			building.style === "largePanel"
				? FLAT_BUILDING_DELTAS.largePanel
				: FLAT_BUILDING_DELTAS[building.style];
		score += delta;
		reasons.push({
			label:
				delta < 0
					? `${building.label}: lower property score`
					: `${building.label}: preferred building`,
			impact: delta,
		});
	}
	const condition = conditionDelta(input.condition);
	score += condition;
	if (condition >= 4)
		reasons.push({ label: "good or very good condition", impact: condition });
	const material = materialDelta(input.buildingMaterial);
	if (!building) score += material;
	if (!building && material >= 3)
		reasons.push({ label: "brick or concrete construction", impact: material });
	if (input.hasBalcony) score += 2;
	if (input.hasTerrace) score += 3;
	if (input.hasGarden) score += 3;
	if (input.hasElevator) score += 4;
	if (input.hasParking) score += 4;
	if (input.hasGarage) score += 4;
	if (input.hasBasement) score += 2;
	if (input.rooms != null) {
		score += input.rooms === 1 ? -2 : input.rooms <= 3 ? 5 : 2;
	}
	const heating = heatingEvidence(input);
	score += heating.delta;
	if (heating.kind === "district" || heating.kind === "heatPump") {
		reasons.push({
			label: "district or efficient heating",
			impact: heating.delta,
		});
	} else if (
		heating.delta < 0 &&
		(heating.kind === "gas" || heating.kind === "electric")
	) {
		reasons.push({ label: "expensive heating", impact: heating.delta });
	}
	const ownership = ownershipDelta(input.ownership);
	score += ownership;
	if (ownership < 0)
		reasons.push({ label: "leasehold or share ownership", impact: ownership });
	return { score: clamp(score, 0, 100), confidence: 0.65, reasons };
}

function houseProperty(input: ScoreListingInput): Component {
	let score = 60;
	const reasons: Array<{ label: string; impact: number }> = [];
	const plot = input.plotAreaM2 ?? null;
	if (plot != null) {
		if (plot >= 1000) score += 8;
		else if (plot >= 500) score += 5;
		else if (plot < 200) score -= 8;
	}
	const type = input.buildingType?.toLowerCase() ?? "";
	if (type.includes("detached") || type.includes("wolnostoj")) score += 6;
	else if (type.includes("semi") || type.includes("bliźniak")) score += 3;
	else if (type.includes("townhouse") || type.includes("szereg")) score += 2;
	const year = yearDelta(input.buildYear);
	score += year;
	const condition = conditionDelta(input.condition);
	score += condition;
	if (condition >= 4)
		reasons.push({ label: "good or very good condition", impact: condition });
	const material = materialDelta(input.buildingMaterial);
	if (!materialDelta(input.buildingType)) score += material;
	score += heatingEvidence(input).delta;
	score += ownershipDelta(input.ownership);
	if (input.hasGarage) score += 6;
	if (input.hasGarden) score += 8;
	if (input.hasTerrace) score += 3;
	if (input.hasParking) score += 5;
	if (input.hasBasement) score += 3;
	if (plot != null && plot >= 500)
		reasons.push({ label: "large plot", impact: 6 });
	// Character is what makes a holiday house worth renting: wood, age, plot
	// size and solitude, each with its own named reason.
	for (const signal of houseCharacter(input)) {
		score += signal.delta;
		reasons.push({ label: signal.label, impact: signal.delta });
	}
	return { score: clamp(score, 0, 100), confidence: 0.6, reasons };
}

function plotProperty(input: ScoreListingInput): Component {
	let score = 60;
	const reasons: Array<{ label: string; impact: number }> = [];
	const text = textUniqueness(input.title, input.description);
	const textBody = `${input.title}\n${input.description ?? ""}`;
	const missingMedia =
		/bez medi|brak medi|media do pod|bez pr[ąa]du|bez wody|brak kanaliz|niepod[łl]ącz/iu.test(
			textBody,
		);
	const type = (input.plotType ?? "").toLowerCase();
	if (type.includes("budowl") || type.includes("build")) score += 10;
	else if (type.includes("roln") || type.includes("agric")) score -= 10;
	else if (type.includes("siedlisk")) score += 4;
	else if (type.includes("rekreac")) score -= 2;
	const area = input.plotAreaM2 ?? input.areaM2;
	if (area != null) {
		if (area >= 1500) score += 3;
		else if (area >= 500) score += 5;
		else if (area < 300) score -= 8;
	}
	const parcel = input.parcelFeatures;
	if (parcel) {
		if (parcel.roadDistanceM != null) {
			if (parcel.roadDistanceM <= 50) score += 8;
			else if (parcel.roadDistanceM <= 150) score += 4;
			else if (parcel.roadDistanceM > 500) score -= 6;
		}
		if (parcel.roadClass && /asfalt|paved|utwardz/i.test(parcel.roadClass))
			score += 4;
		if (parcel.zoningWz) score += 6;
		if (parcel.zoningNoPlan) score -= 4;
		if ((parcel.zoningPlanCount ?? 0) > 0) score += 4;
		if (parcel.floodRisk) {
			score -= 12;
			reasons.push({ label: "flood risk on the parcel", impact: -12 });
		}
		if (parcel.slopeDeg != null) {
			if (parcel.slopeDeg > 25) score -= 10;
			else if (parcel.slopeDeg > 15) score -= 5;
		}
		if ((parcel.buildingCoverage ?? 1) < 0.2) score += 3;
	}
	if (type.includes("budowl"))
		reasons.push({ label: "building plot", impact: 10 });
	if (parcel?.zoningWz)
		reasons.push({ label: "zoning decision (WZ) in place", impact: 6 });
	if ((parcel?.zoningPlanCount ?? 0) > 0) {
		reasons.push({
			label: "local zoning plan covers the parcel",
			impact: 5,
		});
	}
	if (text.utilities && !missingMedia) {
		score += 8;
		reasons.push({
			label: "media or utilities mentioned in the offer",
			impact: 8,
		});
	} else if (missingMedia) {
		score -= 4;
		reasons.push({
			label: "the offer mentions missing or unconnected media",
			impact: -4,
		});
	}
	if (
		text.buildingPermit &&
		!parcel?.zoningWz &&
		(parcel?.zoningPlanCount ?? 0) === 0
	) {
		score += 4;
		reasons.push({
			label: "permit or zoning mentioned in the offer",
			impact: 4,
		});
	}
	return { score: clamp(score, 0, 100), confidence: 0.55, reasons };
}

function propertyComponent(input: ScoreListingInput): Component {
	if (input.segment === "flat") return flatProperty(input);
	if (input.segment === "house") return houseProperty(input);
	return plotProperty(input);
}

function riskComponent(
	input: ScoreListingInput,
	geo: GeoUniqueness | null,
	estimate: ValuationEstimate | null,
): Component {
	let score = 85;
	const reasons: Array<{ label: string; impact: number }> = [];
	const flags: string[] = [];
	if (!geo) {
		score -= 20;
		flags.push("missing_coordinates");
	}
	if (!estimate) {
		score -= 15;
		flags.push("no_comparable_estimate");
	} else if (estimate.confidence.totalCount < 5) {
		score -= 10;
		flags.push("few_comparables");
	}
	if (
		estimate?.confidence.spreadPct != null &&
		estimate.confidence.spreadPct > 30
	) {
		score -= 8;
		flags.push("wide_comp_spread");
	}
	// A high but not impossible index factor: the comps are old and the series
	// is doing heavy lifting, so the fair value is less trustworthy than the
	// sample size suggests. A factor past `maxIndexFactor` is a hard gate.
	const indexFactor = estimate?.statistics.timeFactorMedian ?? null;
	if (
		indexFactor != null &&
		indexFactor > ALERT_GATES.highIndexFactor &&
		indexFactor <= ALERT_GATES.maxIndexFactor
	) {
		score -= 8;
		flags.push("high_index_factor");
	}
	if (geo?.railM != null && geo.railM < 200) {
		score -= 15;
		flags.push("rail_noise");
		reasons.push({ label: "railway noise risk", impact: -10 });
	}
	if (input.parcelFeatures?.floodRisk) {
		score -= 20;
		flags.push("flood_risk");
	}
	const ownership = input.ownership?.toLowerCase() ?? "";
	if (ownership === "leasehold") {
		score -= 12;
		flags.push("leasehold");
	}
	if (ownership === "share") {
		score -= 12;
		flags.push("share_ownership");
	}
	if (input.auctionType) {
		score -= 10;
		flags.push("auction");
		reasons.push({ label: "auction or tender sale", impact: -8 });
	}
	if (input.price == null || input.areaM2 == null) {
		score -= 10;
		flags.push("missing_price_or_area");
	}
	return { score: clamp(score, 0, 100), confidence: 0.75, reasons, flags };
}

/**
 * The building class of a flat: the model's reading of the ad first, the
 * structured columns second. `oldBlock` is the gate answer (a large-panel
 * building, or a block proved to predate 2000).
 */
function flatBuilding(input: ScoreListingInput) {
	return buildingClassOf({
		buildingType: input.buildingType,
		buildingMaterial: input.buildingMaterial,
		buildYear: input.buildYear,
		propertyKind: "apartment",
		facts: {
			// The model reads the ad first; when it has not run (or answered
			// nothing) the narrow lexicon still names a block, a kamienica or a
			// large-panel building the ad states in passing.
			buildingStyle:
				input.facts?.buildingStyle ??
				buildingStyleFromProse(`${input.title}\n${input.description ?? ""}`),
			buildYear: input.facts?.buildYear ?? null,
			technology: input.facts?.technology ?? null,
		},
	});
}

/** MPZP purposes that allow a house. */
const PLAN_PURPOSES = new Set([
	"residential",
	"residential_services",
	"multi_family",
	"mixed",
]);

/** MPZP symbol prefixes that allow a house (MN, MW, U, RM, ...). */
const PLAN_SYMBOL = /^(mn|mw|uz|uc|u|p|rm)/iu;

/**
 * District heating or a heat pump. Gas, electric, coal, oil and unknown fail:
 * the kind is resolved from the structured field, the portal attribute blob
 * or the description, so a seller writing "ogrzewanie miejskie" qualifies.
 */
function hasDistrictHeating(input: ScoreListingInput): boolean {
	const { kind } = heatingEvidence(input);
	return kind === "district" || kind === "heatPump";
}

/**
 * Buildable-land evidence, used as the gate for BOTH plots and houses: the
 * question a buyer asks of a parcel is "can I build something here", and a
 * house that already stands on it does not answer that. Evidence, in order of
 * authority:
 *   1. the portal's plot type (budowlana / inwestycyjna)
 *   2. the parcel record: a WZ decision, a zoning plan, or a built-up /
 *      residential EGiB land-use class (B*, MN, MW, RM)
 *   3. the LLM facts: the WZ/MPZP paragraph, the plan symbol and the declared
 *      purpose the description stated
 * Nothing found means no evidence, and the offer never alerts.
 */
function hasBuildableEvidence(input: ScoreListingInput): boolean {
	const type = (input.plotType ?? "").toLowerCase();
	if (
		type.includes("budowl") ||
		type.includes("build") ||
		type.includes("inwesty")
	) {
		return true;
	}
	const parcel = input.parcelFeatures;
	if (parcel?.zoningWz === true || (parcel?.zoningPlanCount ?? 0) > 0) {
		return true;
	}
	const landUse = (parcel?.landUseClass ?? "").trim().toLowerCase();
	if (landUse.length > 0 && /^(b|mn|mw|rm)/u.test(landUse)) return true;
	const plot = input.facts?.plot ?? null;
	if (plot == null) return false;
	if (plot.wz === true) return true;
	if (plot.type === "budowlana" || plot.type === "inwestycyjna") return true;
	if (plot.mpzpPurpose != null && PLAN_PURPOSES.has(plot.mpzpPurpose)) {
		return true;
	}
	if (plot.mpzpSymbol != null && PLAN_SYMBOL.test(plot.mpzpSymbol.trim())) {
		return true;
	}
	return false;
}

/**
 * Character evidence for the holiday-house target: wood, age, size, solitude.
 * Each entry is a delta with the label the card shows; the gate needs at least
 * one positive entry, so an ordinary suburban house never alerts while a
 * "neighbour behind the fence" penalty still lowers the score of one that does.
 */
function houseCharacter(
	input: ScoreListingInput,
): Array<{ label: string; delta: number }> {
	const out: Array<{ label: string; delta: number }> = [];
	const material = `${input.buildingMaterial ?? ""}`.toLowerCase();
	if (/drewn|wood|bal|log|szkielet/iu.test(material)) {
		out.push({ label: "drewniany / szkieletowy", delta: 12 });
	}
	if (input.facts?.technology === "framed") {
		out.push({ label: "technologia szkieletowa", delta: 6 });
	}
	const year = input.buildYear ?? input.facts?.buildYear ?? null;
	if (year != null && year <= HOUSE_UNIQUENESS.retroBuiltBefore) {
		out.push({ label: `retro (${year})`, delta: 6 });
	}
	const plot = input.plotAreaM2 ?? input.facts?.plotAreaM2 ?? null;
	if (plot != null && plot >= HOUSE_UNIQUENESS.bigPlotM2) {
		out.push({ label: `duża działka (${Math.round(plot)} m²)`, delta: 6 });
	}
	const nearest = input.neighbours?.nearestBuildingM ?? null;
	if (nearest != null && nearest >= HOUSE_UNIQUENESS.veryIsolatedM) {
		out.push({ label: `bez sąsiadów (${Math.round(nearest)} m)`, delta: 14 });
	} else if (nearest != null && nearest >= HOUSE_UNIQUENESS.isolatedM) {
		out.push({ label: `osobno (${Math.round(nearest)} m)`, delta: 10 });
	}
	if (nearest != null && nearest < 25) {
		out.push({ label: "sąsiad za płotem", delta: -12 });
	}
	if (
		input.neighbours != null &&
		input.neighbours.buildingsWithin150m <= HOUSE_UNIQUENESS.hamletNeighbours
	) {
		out.push({ label: "spokojna okolica", delta: 4 });
	}
	return out;
}

/**
 * Nature around a house: water, forest or mountains, from the OSM proximity
 * layer plus the setting the extractor read out of the ad. This replaces the
 * buildable-land gate: a holiday house is bought for what surrounds it.
 */
function houseHasNature(
	input: ScoreListingInput,
	geo: GeoUniqueness | null,
): boolean {
	const context = input.facts?.context ?? null;
	if (
		context?.lake ||
		context?.river ||
		context?.forest ||
		context?.mountains
	) {
		return true;
	}
	if (geo == null) return false;
	if (geo.waterM != null && geo.waterM <= HOUSE_UNIQUENESS.natureWaterM) {
		return true;
	}
	if (geo.forestM != null && geo.forestM <= HOUSE_UNIQUENESS.natureForestM) {
		return true;
	}
	return geo.forestShare500m >= 0.3 || geo.waterShare1000m >= 0.2;
}

/**
 * Additive amenity points. These are observed facts, not estimates, so they
 * bypass the confidence compression the weighted components go through and
 * are added to the final 0-100 score as their own named reasons.
 */
function amenityBonusReasons(
	input: ScoreListingInput,
	geo: GeoUniqueness | null,
): Array<{ label: string; impact: number }> {
	const reasons: Array<{ label: string; impact: number }> = [];
	const heatingKind = heatingEvidence(input).kind;
	if (heatingKind === "district" || heatingKind === "heatPump") {
		reasons.push({
			label: heatingKind === "heatPump" ? "heat pump" : "municipal heating",
			impact: AMENITY_BONUSES.districtHeating,
		});
	}
	if (input.segment === "flat") {
		const zone = nearestCentreAnchor(input.lat, input.lng, input.city);
		if (zone != null && zone.distanceM <= CENTRE_ZONE.radiusM) {
			reasons.push({
				label: `centre zone: ${centreLabel(zone)}`,
				impact: CENTRE_ZONE.bonus,
			});
		}
	} else if (input.segment === "plot") {
		const rail = nearestFastRail(input.lat, input.lng);
		if (rail != null && rail.distanceM <= FAST_RAIL.gateRadiusM) {
			reasons.push({
				label: rail.kdpPlanned
					? `planned KDP station: ${fastRailLabel(rail)}`
					: `200 km/h+ station: ${fastRailLabel(rail)}`,
				impact: FAST_RAIL.bonus,
			});
			if (rail.kdpPlanned) {
				reasons.push({
					label: `KDP train service from ${rail.station.kdpYear ?? 2035}`,
					impact: FAST_RAIL.kdpBonus,
				});
			}
		}
	} else {
		// Holiday house: the surroundings are the product, and the local
		// short-term-rental market is the business case.
		const water = Math.min(
			geo?.lakeM ?? Number.POSITIVE_INFINITY,
			geo?.riverM ?? Number.POSITIVE_INFINITY,
			geo?.waterM ?? Number.POSITIVE_INFINITY,
		);
		if (Number.isFinite(water) && water <= 300) {
			reasons.push({
				label: `woda ${Math.round(water)} m`,
				impact: AMENITY_BONUSES.holidayWater,
			});
		}
		if (geo?.forestM != null && geo.forestM <= 300) {
			reasons.push({
				label: `las ${Math.round(geo.forestM)} m`,
				impact: AMENITY_BONUSES.holidayForest,
			});
		}
		if (input.facts?.context?.mountains === true) {
			reasons.push({
				label: "góry w otoczeniu",
				impact: AMENITY_BONUSES.holidayMountains,
			});
		}
		const nearest = input.neighbours?.nearestBuildingM ?? null;
		if (nearest != null && nearest >= HOUSE_UNIQUENESS.isolatedM) {
			reasons.push({
				label: `najbliższy budynek ${Math.round(nearest)} m`,
				impact: AMENITY_BONUSES.holidayIsolation,
			});
		}
		const str = input.str ?? null;
		if (str?.nightlyMedian != null && str.sampleCount >= STR_MARKET.minSample) {
			for (const [threshold, points] of STR_MARKET.bands) {
				if (str.nightlyMedian >= threshold) {
					reasons.push({
						label: `rynek Airbnb ok. ${Math.round(str.nightlyMedian)} zł/noc (${str.sampleCount} ofert)`,
						impact: points,
					});
					break;
				}
			}
		}
	}
	if (
		input.segment === "flat" &&
		inTramCity(input.city) &&
		geo?.tramM != null &&
		geo.tramM <= AMENITY_BONUS_RANGE.tramM
	) {
		reasons.push({
			label: `tram stop within ${Math.round(geo.tramM)} m`,
			impact: AMENITY_BONUSES.tramStop,
		});
	}
	if (
		geo?.trainStationM != null &&
		geo.trainStationM <= AMENITY_BONUS_RANGE.stationM
	) {
		reasons.push({
			label: `railway station within ${(geo.trainStationM / 1000).toFixed(1)} km`,
			impact: AMENITY_BONUSES.railStation,
		});
	}
	if (input.segment === "plot") {
		// A forest or lake on the parcel (or right next to it) is worth three
		// times the base value; the same feature within the range is worth a
		// third. The parcel radius approximates "same or adjacent parcel"
		// without a full polygon-neighbour search.
		const area = input.plotAreaM2 ?? input.areaM2 ?? 0;
		const adjacentM =
			Math.sqrt(Math.max(area, 0) / Math.PI) + PLOT_GREEN.adjacentMarginM;
		const pushTier = (
			label: string,
			distance: number | null | undefined,
			base: number,
		) => {
			if (distance == null) return;
			if (distance <= adjacentM) {
				reasons.push({
					label: `${label} on or next to the plot`,
					impact: Math.round(base * PLOT_GREEN.nearMultiplier * 10) / 10,
				});
			} else if (distance <= PLOT_GREEN.rangeM) {
				reasons.push({
					label: `${label} within ${(distance / 1000).toFixed(1)} km`,
					impact: Math.round((base / PLOT_GREEN.farDivisor) * 10) / 10,
				});
			}
		};
		pushTier("forest", geo?.forestM, AMENITY_BONUSES.park);
		pushTier("lake", geo?.waterM, AMENITY_BONUSES.water);
	} else {
		if (geo?.parkM != null && geo.parkM <= AMENITY_BONUS_RANGE.parkM) {
			reasons.push({
				label: `park within ${Math.round(geo.parkM)} m`,
				impact: AMENITY_BONUSES.park,
			});
		}
		if (geo?.waterM != null && geo.waterM <= AMENITY_BONUS_RANGE.waterM) {
			reasons.push({
				label: `water within ${Math.round(geo.waterM)} m`,
				impact: AMENITY_BONUSES.water,
			});
		}
	}
	if (input.hasElevator) {
		reasons.push({ label: "elevator", impact: AMENITY_BONUSES.elevator });
	}
	if (input.hasParking || input.hasGarage) {
		reasons.push({ label: "parking", impact: AMENITY_BONUSES.parking });
	}
	return reasons;
}

export function scoreAlert(
	input: ScoreListingInput,
	estimate: ValuationEstimate | null,
	geo: GeoUniqueness | null,
): AlertScore {
	const weights = SEGMENT_WEIGHTS[input.segment];
	const value = valueComponent(input, estimate);
	const transit = transitComponent(input, geo);
	const green = greenComponent(geo);
	const property = propertyComponent(input);
	const risk = riskComponent(input, geo, estimate);

	const components = { value, transit, green, property, risk };
	const totalWeight =
		weights.value +
		weights.transit +
		weights.green +
		weights.property +
		weights.risk;
	const raw =
		(value.score * weights.value +
			transit.score * weights.transit +
			green.score * weights.green +
			property.score * weights.property +
			risk.score * weights.risk) /
		totalWeight;

	const confidence =
		value.confidence * weights.value +
		transit.confidence * weights.transit +
		green.confidence * weights.green +
		property.confidence * weights.property +
		risk.confidence * weights.risk;
	const bonuses = amenityBonusReasons(input, geo);
	const bonusPoints = bonuses.reduce((sum, bonus) => sum + bonus.impact, 0);
	const weighted = clamp(50 + (raw - 50) * (0.65 + 0.35 * confidence), 0, 100);
	// Amenity points are applied against the remaining headroom, so a strong
	// offer still gains from them without every top candidate collapsing into
	// the same 100. `AMENITY_HEADROOM_SCALE` is larger than the bonus budget,
	// which keeps the total strictly increasing in the weighted score.
	const headroom = Math.min(
		1,
		Math.max(0, (100 - weighted) / AMENITY_HEADROOM_SCALE),
	);
	const totalScore = clamp(weighted + bonusPoints * headroom, 0, 100);

	const applying: Array<{ label: string; impact: number }> = [];
	for (const key of [
		"value",
		"transit",
		"green",
		"property",
		"risk",
	] as const) {
		const component = components[key];
		for (const reason of component.reasons) {
			applying.push({
				label: reason.label,
				impact: reason.impact * weights[key],
			});
		}
	}
	for (const bonus of bonuses) applying.push(bonus);
	const reasons: ScoreReason[] = applying
		.filter((reason) => Math.abs(reason.impact) >= 1)
		.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
		.slice(0, 8)
		.map((reason) => ({
			...reason,
			impact: Math.round(reason.impact * 10) / 10,
			direction: reason.impact >= 0 ? "positive" : "negative",
		}));

	const flags = [
		...new Set(
			Object.values(components).flatMap((component) => component.flags ?? []),
		),
	];
	const asking = input.price;
	const fair = estimate?.fairPrice ?? null;
	// The headline discount is the raw asking price against the local
	// comparable median, with NO negotiation margin. This is what the user
	// sees and what the alert gate checks. The margin lives only inside the
	// value component above.
	const discountPct =
		asking != null && asking > 0 && fair != null && fair > 0
			? (1 - asking / fair) * 100
			: null;

	// Every gate is evaluated, not just until the first failure: the
	// leaderboard needs to know whether a flat failed *only* on evidence the
	// extractor could not find (heating, tenement age/style), which are the
	// failures it may fill a section with (clearly marked) when the strict
	// pool is short. A gate proved against the offer (gas heating, panel block,
	// a confirmed modern block) is never a fallback.
	const gateFailures: string[] = [];
	const zone = nearestCentreAnchor(input.lat, input.lng, input.city);
	const rail = nearestFastRail(input.lat, input.lng);
	// Every location signal (centre zone, rail distance, comp set) is derived
	// from the listing's coordinates. When those are a shared city-centre
	// placeholder the whole score is geography fiction: "Giszowiec 59 m²" sat on
	// the Katowice Rynek 62 m from the anchor, and a plot in Janczowa (a village
	// 100 km away) sat on the same point and "discounted 94%" against central
	// building land.
	if (input.placeholderCoordinates) {
		gateFailures.push("placeholder_coordinates");
	}
	if (input.segment === "flat") {
		// Only old blocks are excluded. A tenement, a new block, an apartment
		// building and a block whose age nobody stated are all allowed; the card
		// names the class so the reader can judge it.
		if (
			SEGMENT_ELIGIBILITY.flatExcludesOldBlock &&
			flatBuilding(input).oldBlock
		) {
			gateFailures.push("old_block");
		}
		if (
			SEGMENT_ELIGIBILITY.flatRequiresDistrictHeating &&
			!hasDistrictHeating(input)
		) {
			// Gas, electric, coal and oil are a statement against municipal
			// heating; no evidence at all is merely unknown.
			gateFailures.push(
				heatingEvidence(input).kind === "unknown"
					? "no_heating_evidence"
					: "non_municipal_heating",
			);
		}
		if (
			SEGMENT_ELIGIBILITY.flatRequiresCentreZone &&
			(zone == null || zone.distanceM > CENTRE_ZONE.radiusM)
		) {
			gateFailures.push("outside_centre_zone");
		}
	}
	if (
		SEGMENT_ELIGIBILITY.plotRequiresBuildingEvidence &&
		input.segment === "plot" &&
		!hasBuildableEvidence(input)
	) {
		gateFailures.push("not_building_plot");
	}
	if (input.segment === "house") {
		if (
			SEGMENT_ELIGIBILITY.houseRequiresNature &&
			!houseHasNature(input, geo)
		) {
			gateFailures.push("no_nature_setting");
		}
		if (
			SEGMENT_ELIGIBILITY.houseRequiresCharacter &&
			!houseCharacter(input).some((signal) => signal.delta > 0)
		) {
			gateFailures.push("no_house_character");
		}
	}
	if (input.segment === "plot" && SEGMENT_ELIGIBILITY.plotRequiresFastRail) {
		if (rail == null || rail.distanceM > FAST_RAIL.gateRadiusM) {
			gateFailures.push("outside_fast_rail");
		}
	}
	if (estimate == null || fair == null || fair <= 0)
		gateFailures.push("no_comparable_estimate");
	else {
		if (estimate.confidence.totalCount < 3) {
			// The valuation itself refuses fewer than three comps; an estimate
			// that still reaches here is too thin to alert on.
			gateFailures.push("thin_comps");
		}
		if (discountPct == null || discountPct < ALERT_GATES.minDiscountPct) {
			gateFailures.push("discount_below_gate");
		}
		// Plausibility of the discount itself. An offer priced at a fraction of
		// its own "fair value" is nearly always a broken comp set (land against
		// land of another type, a placeholder location, a thin cell index), not a
		// bargain, and surfacing it as the day's best is the worst failure the
		// leaderboard can have. A large discount must be carried by a broad and
		// tight sample; past `maxDiscountPct` no sample makes it credible.
		if (discountPct != null && discountPct >= ALERT_GATES.maxDiscountPct) {
			gateFailures.push("implausible_discount");
		}
		if (
			discountPct != null &&
			discountPct >= ALERT_GATES.unverifiedDiscountPct &&
			discountPct < ALERT_GATES.maxDiscountPct &&
			(estimate.confidence.totalCount <
				ALERT_GATES.unverifiedDiscountMinComps ||
				estimate.confidence.spreadPct >
					ALERT_GATES.unverifiedDiscountMaxSpreadPct)
		) {
			gateFailures.push("unverified_discount");
		}
		// The fair value is a comp price carried to today by a price index.
		// A broken index series (a thin grid cell, a handful of odd notarial
		// prices) turns that multiplication into fiction: the live house list
		// showed factors of x5.07, x2.20 and x1.92 on 2021-2022 comps, which is
		// not what the market did, and every one of those inflated the "discount".
		const indexFactor = estimate.statistics.timeFactorMedian;
		if (
			indexFactor != null &&
			(indexFactor > ALERT_GATES.maxIndexFactor ||
				indexFactor < ALERT_GATES.minIndexFactor)
		) {
			gateFailures.push("broken_index_factor");
		}
		if (value.score < ALERT_GATES.minValueScore) {
			gateFailures.push("value_score_below_gate");
		}
		if (confidence < ALERT_GATES.minConfidence) {
			gateFailures.push("confidence_below_gate");
		}
	}
	const gateReason = gateFailures[0] ?? null;
	// A flat whose building nobody described is allowed (only old blocks are
	// excluded), but the card says the class is missing rather than letting it
	// read as a building claim.
	if (input.segment === "flat" && flatBuilding(input).kind === "unknown") {
		flags.push("building_class_unknown");
	}
	// The one failure a section may fill with, clearly marked on the card. Both
	// entries mean "the extractor found no evidence", never "the offer says no".
	const FALLBACK_GATES = new Set([
		"no_heating_evidence",
		// The plot gate above pushes `not_building_plot`; the old name here
		// never matched, so a plot missing building evidence could never fill
		// a short Działki section.
		"not_building_plot",
	]);
	const fallbackEligible =
		gateFailures.length > 0 &&
		gateFailures.every((failure) => FALLBACK_GATES.has(failure));

	return {
		scoreVersion: SCORE_VERSION,
		segment: input.segment,
		region: input.region,
		valueScore: Math.round(value.score),
		transitScore: Math.round(transit.score),
		greenScore: Math.round(green.score),
		propertyScore: Math.round(property.score),
		riskScore: Math.round(risk.score),
		totalScore: Math.round(totalScore * 10) / 10,
		confidence: Math.round(confidence * 100) / 100,
		discountPct: discountPct == null ? null : Math.round(discountPct * 10) / 10,
		fairPrice: fair,
		fairM2: estimate?.fairM2 ?? null,
		askingPrice: asking,
		compCount: estimate?.confidence.totalCount ?? 0,
		compRcnCount: estimate?.confidence.rcnCount ?? 0,
		eligible: gateFailures.length === 0,
		/** All gates pass except proof of municipal heating. */
		fallbackEligible,
		gateReason,
		reasons,
		flags,
		amenities: geo,
		valuation: scoreValuation(estimate),
	};
}
