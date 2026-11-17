/**
 * Deterministic, explainable alert score.
 *
 * The score is a weighted sum of five 0-100 components. It never calls an ML
 * model. Every component is monotonic in the signal it represents: a larger
 * discount, a closer tram stop, more forest cover, or a lower risk flag can
 * never reduce that component.
 */

import { clamp } from "#/lib/stats";
import type { GeoUniqueness } from "#/lib/valuation/uniqueness-geo";
import { textUniqueness } from "#/lib/valuation/uniqueness-text";
import type { ValuationEstimate } from "#/types/listing";
import {
	ALERT_GATES,
	type AlertSegment,
	DISTANCE_BANDS,
	distanceScore,
	ESTIMATE_CONFIDENCE,
	FLAT_BUILDING_DELTAS,
	HEATING_DELTAS,
	PLOT_LISTING_BASE_CONFIDENCE,
	PLOT_LISTING_RCN_FACTOR,
	PLOT_SPREAD_FACTOR_FLOOR,
	SCORE_VERSION,
	SEGMENT_WEIGHTS,
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

export interface ScoreParcelFeatures {
	areaM2?: number | null;
	frontageM?: number | null;
	roadDistanceM?: number | null;
	roadClass?: string | null;
	buildingCoverage?: number | null;
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
	eligible: boolean;
	gateReason: string | null;
	reasons: ScoreReason[];
	flags: string[];
	amenities: GeoUniqueness | null;
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
	const center = distanceScore(geo.centerM, DISTANCE_BANDS.center);
	let score =
		tram * mix.tram + train * mix.train + bus * mix.bus + center * mix.center;
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
	if (geo.centerM != null && geo.centerM <= 2500) {
		reasons.push({
			label: `${(geo.centerM / 1000).toFixed(1)} km to the city centre`,
			impact: 6,
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
	// No structured signal: the title is the only honest evidence left.
	const text = `${input.title} ${input.description ?? ""}`.toLowerCase();
	if (/wielka[ _-]?p[ył]yta|wielkopłyta|blok(?:u|i|ów)?\b/u.test(text)) {
		return { style: "largePanel", label: "blok / wielka płyta (z opisu)" };
	}
	if (/kamienic/u.test(text)) {
		return { style: "tenement", label: "kamienica (z opisu)" };
	}
	if (/apartamentowiec/u.test(text)) {
		return { style: "apartmentBuilding", label: "apartamentowiec (z opisu)" };
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

function heatingDelta(heating: string | null | undefined): number {
	const value = heating?.toLowerCase() ?? "";
	if (/pompa|heat[ _-]?pump/u.test(value)) return HEATING_DELTAS.heatPump;
	if (/(?:c\.?o\.?\s+)?miejsk|sie[ćc]|urban|district|c.o./u.test(value))
		return HEATING_DELTAS.district;
	if (/elektr/u.test(value)) return HEATING_DELTAS.electric;
	if (/gaz|gas/u.test(value)) return HEATING_DELTAS.gas;
	if (/w[ęe]g|coal|drewno|wood/u.test(value)) return HEATING_DELTAS.coalWood;
	if (/olej|oil/u.test(value)) return HEATING_DELTAS.oil;
	return 0;
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
	const heating = heatingDelta(input.heatingType);
	score += heating;
	if (heating >= HEATING_DELTAS.district) {
		reasons.push({ label: "district or efficient heating", impact: heating });
	} else if (heating <= HEATING_DELTAS.gas) {
		reasons.push({ label: "expensive heating", impact: heating });
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
	score += heatingDelta(input.heatingType);
	score += ownershipDelta(input.ownership);
	if (input.hasGarage) score += 6;
	if (input.hasGarden) score += 8;
	if (input.hasTerrace) score += 3;
	if (input.hasParking) score += 5;
	if (input.hasBasement) score += 3;
	if (plot != null && plot >= 500)
		reasons.push({ label: "large plot", impact: 6 });
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
	const totalScore = clamp(
		50 + (raw - 50) * (0.65 + 0.35 * confidence),
		0,
		100,
	);

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

	let gateReason: string | null = null;
	if (estimate == null || fair == null || fair <= 0)
		gateReason = "no_comparable_estimate";
	else if (discountPct == null || discountPct < ALERT_GATES.minDiscountPct) {
		gateReason = "discount_below_gate";
	} else if (value.score < ALERT_GATES.minValueScore)
		gateReason = "value_score_below_gate";
	else if (confidence < ALERT_GATES.minConfidence)
		gateReason = "confidence_below_gate";

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
		eligible: gateReason == null,
		gateReason,
		reasons,
		flags,
		amenities: geo,
	};
}
