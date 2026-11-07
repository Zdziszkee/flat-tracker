/**
 * Poland-tailored, segment-aware attractiveness scoring.
 *
 * This is an evidence-weighted scoring model, not a black-box AVM. Location,
 * market value, physical attributes and uniqueness are scored separately for
 * apartments, houses and plots. Unknown attributes are neutral and lower
 * confidence instead of being treated as defects. Polish-specific effects
 * include wielka płyta, heating/smog exposure, ownership form, plot zoning,
 * utility/permit evidence and rail noise. Proximity uses local OSM geometry;
 * view/permit/quality statements use the ad text with provenance.
 */

import { clamp } from "#/lib/forecast/core";
import type {
	AttractivenessDto,
	AttractivenessSegment,
	ScoreComponentDto,
	ScoreComponentKey,
} from "#/types/attractiveness";
import type { GeoUniqueness } from "./uniqueness-geo";
import { textEvidence, textUniqueness } from "./uniqueness-text";

export interface AttractivenessInput {
	kind: AttractivenessSegment;
	title: string;
	description?: string | null;
	pricePerM2?: number | null;
	areaM2?: number | null;
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
	estimate?: {
		overUnderPct: number | null;
		confidence?: {
			level?: string;
			totalCount?: number;
			spreadPct?: number;
		} | null;
	} | null;
	upside?: {
		riskAdjustedAnnualPct: number | null;
		volatilityPct?: number | null;
	} | null;
	forecast?: {
		priceQuality?: "high" | "medium" | "low";
	} | null;
	ltYieldPct?: number | null;
	strYieldPct?: number | null;
	publicInvestmentsNearby?: number | null;
	geo: GeoUniqueness | null;
}

const WEIGHTS: Record<
	AttractivenessSegment,
	Record<ScoreComponentKey, number>
> = {
	apartment: {
		value: 0.22,
		market: 0.2,
		location: 0.2,
		property: 0.18,
		uniqueness: 0.12,
		risk: 0.08,
	},
	house: {
		value: 0.18,
		market: 0.17,
		location: 0.2,
		property: 0.25,
		uniqueness: 0.15,
		risk: 0.05,
	},
	plot: {
		value: 0.2,
		market: 0.15,
		location: 0.25,
		property: 0.2,
		uniqueness: 0.15,
		risk: 0.05,
	},
};

const COMPONENT_LABELS: Record<ScoreComponentKey, string> = {
	value: "Cena vs wartość godziwa",
	market: "Rynek i zwrot",
	location: "Lokalizacja i transport",
	property: "Nieruchomość",
	uniqueness: "Unikalność i otoczenie",
	risk: "Ryzyko i pewność danych",
};

interface Evidence {
	text: string;
	impact: number;
}

class EvidenceCollector {
	readonly positive: Evidence[] = [];
	readonly negative: Evidence[] = [];
	add(text: string, impact: number): void {
		if (!Number.isFinite(impact) || Math.abs(impact) < 2) return;
		const item = { text, impact };
		if (impact > 0) this.positive.push(item);
		else this.negative.push(item);
	}
}

function scale(
	value: number | null | undefined,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	fallback = 55,
): number {
	if (value == null || !Number.isFinite(value) || x0 === x1) return fallback;
	const result = y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
	return clamp(result, Math.min(y0, y1), Math.max(y0, y1));
}

function bool(value: boolean | null | undefined): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function distanceText(label: string, meters: number): string {
	return `${label} ${meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`}`;
}

function distanceBonus(
	meters: number | null,
	stops: ReadonlyArray<[number, number]>,
): number {
	if (meters == null) return 0;
	for (const [distance, bonus] of stops) {
		if (meters <= distance) return bonus;
	}
	return 0;
}

function floorNumber(floor: string | null | undefined): number | null {
	if (!floor) return null;
	const text = floor.toLowerCase();
	if (text === "ground_floor" || text === "parter") return 0;
	if (text === "basement" || text === "suterena") return -1;
	const match = text.match(/(-?\d+)/u);
	return match?.[1] ? Number(match[1]) : null;
}

function confidenceLevel(level: string | null | undefined): number {
	return level === "high" ? 0.95 : level === "medium" ? 0.75 : 0.45;
}

function scoreValue(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	const overUnder = input.estimate?.overUnderPct;
	if (overUnder == null) return { score: 55, confidence: 0.2 };
	const score = clamp(65 - overUnder * 1.8, 0, 100);
	if (overUnder <= -5) {
		evidence.add(
			`cena ${Math.abs(overUnder).toFixed(0)}% poniżej wartości godziwej`,
			Math.min(30, -overUnder),
		);
	} else if (overUnder >= 8) {
		evidence.add(
			`cena ${overUnder.toFixed(0)}% powyżej wartości godziwej`,
			-overUnder,
		);
	}
	return {
		score,
		confidence: confidenceLevel(input.estimate?.confidence?.level),
	};
}

function scoreMarket(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	const upside = input.upside?.riskAdjustedAnnualPct;
	const upsideScore = scale(upside, -2, 15, 9, 95);
	if (upside != null && upside >= 7) {
		evidence.add(`zwrot skorygowany ${upside.toFixed(1)}%/rok`, upside);
	}
	const yieldPct = input.ltYieldPct ?? input.strYieldPct ?? null;
	const yieldScore = scale(yieldPct, 2, 25, 9, 90);
	if (yieldPct != null && yieldPct >= 7) {
		evidence.add(`rentowność ${yieldPct.toFixed(1)}%/rok`, yieldPct - 4);
	}
	const count = input.estimate?.confidence?.totalCount;
	const evidenceScore = scale(count, 3, 30, 30, 85, 50);
	const publicInvestments = input.publicInvestmentsNearby ?? 0;
	const publicBonus = Math.min(8, publicInvestments * 2);
	if (publicInvestments > 0) {
		evidence.add(
			`${publicInvestments} inwestycje publiczne w okolicy`,
			publicBonus,
		);
	}
	const quality = input.forecast?.priceQuality;
	return {
		score: clamp(
			upsideScore * 0.45 +
				yieldScore * 0.3 +
				evidenceScore * 0.25 +
				publicBonus,
			0,
			100,
		),
		confidence:
			quality === "high" ? 0.9 : quality === "medium" ? 0.7 : 0.45,
	};
}

function transitScore(
	meters: number | null,
	kind: AttractivenessSegment,
): number {
	if (meters == null) return 45;
	if (kind === "plot") {
		if (meters <= 300) return 65;
		if (meters <= 2500) return 95;
		if (meters <= 5000) return 70;
		return 40;
	}
	if (meters <= 100) return 60;
	if (meters <= 300) return 85;
	if (meters <= 1000) return 100;
	if (meters <= 2000) return 80;
	if (meters <= 4000) return 55;
	return 30;
}

function scoreLocation(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	const geo = input.geo;
	if (!geo) return { score: 55, confidence: 0.2 };
	const centerKm = geo.centerM == null ? null : geo.centerM / 1000;
	const centerScore =
		input.kind === "apartment"
			? scale(centerKm, 0, 98, 20, 25)
			: input.kind === "house"
				? scale(centerKm, 0, 92, 30, 30)
				: scale(centerKm, 0, 85, 40, 35);
	if (centerKm != null && centerKm <= 2) {
		evidence.add("blisko centrum", 8);
	}
	const transit = transitScore(geo.transitM, input.kind);
	if (geo.transitM != null && geo.transitM <= 800) {
		evidence.add(distanceText("transport publiczny", geo.transitM), 8);
	}
	let stationBoost = 0;
	if (geo.trainStationM != null) {
		if (geo.trainStationM >= 300 && geo.trainStationM <= 2000) {
			stationBoost = 6;
			evidence.add(distanceText("stacja kolejowa", geo.trainStationM), 7);
		} else if (geo.trainStationM < 150) {
			stationBoost = -4;
		}
	}
	let railPenalty = 0;
	if (geo.railM != null) {
		if (geo.railM < 100) railPenalty = -20;
		else if (geo.railM < 200) railPenalty = -12;
		else if (geo.railM < 400) railPenalty = -5;
		if (railPenalty < 0) {
			evidence.add(distanceText("hałas kolejowy", geo.railM), railPenalty);
		}
	}
	const publicBonus = Math.min(6, (input.publicInvestmentsNearby ?? 0) * 1.5);
	const centerWeight =
		input.kind === "apartment" ? 0.45 : input.kind === "house" ? 0.35 : 0.3;
	return {
		score: clamp(
			centerScore * centerWeight +
				transit * (1 - centerWeight) +
				stationBoost +
				publicBonus +
				railPenalty,
			0,
			100,
		),
		confidence: 0.85,
	};
}

function heatingDelta(
	heating: string | null | undefined,
	evidence: EvidenceCollector,
): number {
	const value = heating?.toLowerCase() ?? "";
	if (!value) return 0;
	if (value.includes("heat_pump")) {
		evidence.add("pompa ciepła", 8);
		return 8;
	}
	if (value.includes("district") || value.includes("urban")) {
		evidence.add("ogrzewanie miejskie", 5);
		return 5;
	}
	if (value.includes("gas")) return 2;
	if (value.includes("electric")) {
		evidence.add("droższe ogrzewanie elektryczne", -5);
		return -5;
	}
	if (value.includes("coal") || value.includes("wood")) {
		evidence.add("palenisko na węgiel/drewno i ryzyko antysmogowe", -10);
		return -10;
	}
	if (value.includes("oil")) return -5;
	return 0;
}

function conditionDelta(
	condition: string | null | undefined,
	evidence: EvidenceCollector,
): number {
	const value = condition?.toLowerCase() ?? "";
	if (!value) return 0;
	if (["excellent", "new", "very_good"].includes(value)) {
		evidence.add("bardzo dobry stan", 7);
		return 7;
	}
	if (value === "good") return 4;
	if (value === "to_completion") return -3;
	if (["to_renovation", "for_renovation", "to_renovate", "poor", "not_good"].includes(value)) {
		evidence.add("do remontu: koszt i ryzyko wykonania", -7);
		return -7;
	}
	return 0;
}

function ownershipDelta(
	ownership: string | null | undefined,
	evidence: EvidenceCollector,
): number {
	const value = ownership?.toLowerCase() ?? "";
	if (value === "full_ownership") {
		evidence.add("pełna własność", 4);
		return 4;
	}
	if (value === "cooperative") return 0;
	if (value === "leasehold") {
		evidence.add("użytkowanie wieczyste: finansowanie i odsprzedaż", -8);
		return -8;
	}
	if (value === "share") {
		evidence.add("własność cząstkowa / udział", -8);
		return -8;
	}
	return 0;
}

function materialDelta(
	material: string | null | undefined,
	condition: string | null | undefined,
	evidence: EvidenceCollector,
): number {
	const value = material?.toLowerCase() ?? "";
	if (!value) return 0;
	if (value.includes("concrete_plate") || value.includes("wielka_plyta")) {
		evidence.add("wielka płyta: standard i koszty modernizacji", -7);
		return -7;
	}
	if (value.includes("brick")) {
		evidence.add("cegła", 4);
		return 4;
	}
	if (value.includes("concrete")) return 3;
	if (value.includes("tenement")) {
		const bonus = condition === "excellent" || condition === "very_good" ? 5 : 2;
		evidence.add("kamienica", bonus);
		return bonus;
	}
	if (value.includes("wood")) return 2;
	return 0;
}

function yearDelta(
	year: number | null | undefined,
	condition: string | null | undefined,
): number {
	if (year == null) return 0;
	if (year >= 2015) return 8;
	if (year >= 2000) return 5;
	if (year >= 1980) return 1;
	if (year >= 1960) return -2;
	return condition === "excellent" || condition === "very_good" ? 2 : -4;
}

function apartmentProperty(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	let score = 60;
	let known = 0;
	const floor = floorNumber(input.floor);
	if (floor != null) {
		known++;
		if (floor < 0) score -= 25;
		else if (floor === 0) score += input.hasGarden || input.hasTerrace ? -2 : -8;
		else if (floor <= 3) score += 6;
		else if (floor <= 6) score += input.hasElevator ? 3 : -3;
		else score += input.hasElevator ? 3 : -10;
		if (
			input.floorCount != null &&
			input.floorCount > 3 &&
			floor === input.floorCount &&
			input.hasElevator
		) {
			score += 3;
			evidence.add("ostatnie piętro z windą", 4);
		}
	}
	if (input.floorCount != null && input.floorCount >= 5 && input.hasElevator === false) {
		score -= 8;
		evidence.add("wysoki blok bez windy", -8);
	}
	if (input.hasElevator === true) {
		score += 5;
		evidence.add("winda", 5);
	}
	if (input.hasParking === true) {
		score += 10;
		evidence.add("miejsce parkingowe", 10);
	}
	if (input.hasBalcony === true) {
		score += 5;
		evidence.add("balkon", 5);
	}
	if (input.hasTerrace === true) {
		score += 6;
		evidence.add("taras", 6);
	}
	if (input.hasGarden === true) {
		score += 7;
		evidence.add("ogródek", 7);
	}
	if (input.hasBasement === true) score += 2;
	if (input.rooms != null) {
		known++;
		score += input.rooms === 1 ? -2 : input.rooms <= 3 ? 7 : 3;
	}
	if (input.areaM2 != null) {
		known++;
		score +=
			input.areaM2 < 25
				? -10
				: input.areaM2 < 45
					? 2
					: input.areaM2 <= 75
						? 8
						: input.areaM2 <= 110
							? 4
							: -3;
	}
	if (input.buildYear != null) known++;
	if (input.condition) known++;
	if (input.heatingType) known++;
	if (input.ownership) known++;
	if (input.buildingMaterial) known++;
	score += yearDelta(input.buildYear, input.condition);
	score += conditionDelta(input.condition, evidence);
	score += heatingDelta(input.heatingType, evidence);
	score += ownershipDelta(input.ownership, evidence);
	score += materialDelta(input.buildingMaterial, input.condition, evidence);
	if (input.market === "primary") score += 3;
	return {
		score: clamp(score, 0, 100),
		confidence: clamp(0.35 + known * 0.1, 0.35, 0.95),
	};
}

function houseProperty(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	let score = 60;
	let known = 0;
	const plotArea = input.plotAreaM2;
	if (plotArea != null) {
		known++;
		score +=
			plotArea < 300
				? -8
				: plotArea <= 1500
					? 8
					: plotArea <= 4000
						? 5
						: plotArea > 10000
							? -5
							: 0;
	}
	if (input.areaM2 != null) {
		known++;
		score +=
			input.areaM2 < 60
				? -8
				: input.areaM2 <= 220
					? 8
					: input.areaM2 <= 350
						? 4
						: input.areaM2 > 400
							? -4
							: 0;
	}
	if (input.buildingType) {
		known++;
		const type = input.buildingType.toLowerCase();
		if (type === "detached" || type === "house") score += 6;
		else if (type === "semi_detached") score += 3;
		else if (type === "townhouse") score += 2;
		else if (type === "bungalow") score += 3;
	}
	if (input.hasGarage === true) {
		score += 8;
		evidence.add("garaż", 8);
	}
	if (input.hasParking === true) score += 5;
	if (input.hasGarden === true) {
		score += 8;
		evidence.add("ogród", 8);
	}
	if (input.hasTerrace === true) score += 5;
	if (input.hasBasement === true) score += 3;
	if (input.hasBalcony === true) score += 2;
	if (input.plotType) {
		const type = input.plotType.toLowerCase();
		if (type.includes("budowl") || type.includes("siedlisk")) score += 4;
	}
	if (input.buildYear != null) known++;
	if (input.condition) known++;
	if (input.heatingType) known++;
	if (input.ownership) known++;
	if (input.buildingMaterial) known++;
	score += yearDelta(input.buildYear, input.condition);
	score += conditionDelta(input.condition, evidence);
	score += heatingDelta(input.heatingType, evidence);
	score += ownershipDelta(input.ownership, evidence);
	score += materialDelta(input.buildingMaterial, input.condition, evidence);
	return {
		score: clamp(score, 0, 100),
		confidence: clamp(0.35 + known * 0.1, 0.35, 0.95),
	};
}

function plotProperty(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	let score = 55;
	let known = 0;
	const text = textUniqueness(input.title, input.description);
	if (input.plotType) {
		known++;
		const type = input.plotType.toLowerCase();
		if (type.includes("budowl")) {
			score += 18;
			evidence.add("działka budowlana", 18);
		} else if (type.includes("siedlisk")) {
			score += 12;
			evidence.add("przeznaczenie siedliskowe", 12);
		} else if (type.includes("roln")) {
			score -= 15;
			evidence.add("działka rolna: ograniczenia zabudowy", -15);
		} else if (type.includes("rekreac")) {
			score -= 4;
		}
	}
	const area = input.areaM2 ?? input.plotAreaM2;
	if (area != null) {
		known++;
		score +=
			area < 400
				? -10
				: area <= 2500
					? 10
					: area <= 6000
						? 5
						: area > 20000
							? -5
							: 0;
	}
	if (text.utilities) {
		score += 8;
		evidence.add("media / uzbrojenie działki", 8);
		known++;
	}
	if (text.buildingPermit) {
		score += 10;
		evidence.add("pozwolenie na budowę / MPZP", 10);
		known++;
	}
	if (input.ownership) known++;
	score += ownershipDelta(input.ownership, evidence);
	return {
		score: clamp(score, 0, 100),
		confidence: clamp(0.35 + known * 0.12, 0.35, 0.95),
	};
}

function scoreUniqueness(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	const geo = input.geo;
	const text = textUniqueness(input.title, input.description);
	let score = 45;
	if (geo) {
		const park = distanceBonus(geo.parkM, [
			[100, 12],
			[300, 10],
			[800, 6],
			[1500, 3],
			[3000, 0],
		]);
		const forest = distanceBonus(geo.forestM, [
			[100, 14],
			[300, 11],
			[800, 7],
			[2000, 3],
			[3000, 0],
		]);
		const water = distanceBonus(geo.waterM, [
			[100, 16],
			[300, 13],
			[800, 9],
			[2000, 4],
			[3000, 0],
		]);
		const river = distanceBonus(geo.riverM, [
			[100, 10],
			[300, 8],
			[800, 5],
			[1500, 2],
			[3000, 0],
		]);
		const natureMultiplier = input.kind === "plot" ? 1.2 : 1;
		score += (park + forest + water + river) * natureMultiplier;
		if (geo.parkM != null && park >= 6) {
			evidence.add(distanceText("park", geo.parkM), park);
		}
		if (geo.forestM != null && forest >= 6) {
			evidence.add(distanceText("las", geo.forestM), forest);
		}
		if (geo.waterM != null && water >= 6) {
			evidence.add(distanceText("jezioro / woda", geo.waterM), water);
		}
		if (geo.riverM != null && river >= 5) {
			evidence.add(distanceText("rzeka", geo.riverM), river);
		}
	}
	const viewMultiplier = input.kind === "apartment" ? 1.2 : 1;
	if (text.panoramicView) {
		score += 14 * viewMultiplier;
		evidence.add("panorama miasta (z ogłoszenia)", 14 * viewMultiplier);
	}
	if (text.mountainView) {
		score += 10;
		evidence.add("widok na góry (z ogłoszenia)", 10);
	}
	if (text.waterView) {
		score += 12;
		evidence.add("widok na wodę (z ogłoszenia)", 12);
	}
	if (text.parkView) {
		score += 6;
		evidence.add("widok na park (z ogłoszenia)", 6);
	}
	if (text.forestView) {
		score += 8;
		evidence.add("widok na las (z ogłoszenia)", 8);
	}
	if (text.quiet) {
		score += 5;
		evidence.add("cicha okolica", 5);
	}
	if (text.airConditioning) score += 2;
	if (text.fireplace) {
		score += 2;
		evidence.add("kominek", 2);
	}
	if (text.energyEfficient) {
		score += 3;
		evidence.add("rozwiązania energooszczędne", 3);
	}
	if (text.southFacing) score += 2;
	const textCount = textEvidence(text).length;
	return {
		score: clamp(score, 0, 100),
		confidence: geo ? 0.85 : textCount > 0 ? 0.55 : 0.25,
	};
}

function scoreRisk(
	input: AttractivenessInput,
	evidence: EvidenceCollector,
): { score: number; confidence: number } {
	let score = 90;
	const spread = input.estimate?.confidence?.spreadPct;
	if (spread != null) {
		if (spread > 50) score -= 20;
		else if (spread > 30) score -= 10;
	}
	if (input.forecast?.priceQuality === "low") score -= 8;
	if (input.condition && /renovation|poor|not_good/.test(input.condition)) {
		score -= 6;
	}
	if (input.ownership === "leasehold") score -= 6;
	if (input.ownership === "share") score -= 8;
	const text = textUniqueness(input.title, input.description);
	if (text.floodRisk) {
		score -= 15;
		evidence.add("ryzyko zalewowania wskazane w ogłoszeniu", -15);
	}
	if (text.busyRoad) {
		score -= 5;
		evidence.add("ruchliwa droga / hałas", -5);
	}
	if (!input.geo) score -= 5;
	if (!input.estimate) score -= 8;
	if (input.buildYear == null && input.kind !== "plot") score -= 3;
	const volatility = input.upside?.volatilityPct;
	if (volatility != null && volatility > 15) score -= 5;
	return { score: clamp(score, 0, 100), confidence: 0.65 };
}

export function scoreAttractiveness(
	input: AttractivenessInput,
): AttractivenessDto {
	const evidence = new EvidenceCollector();
	const value = scoreValue(input, evidence);
	const market = scoreMarket(input, evidence);
	const location = scoreLocation(input, evidence);
	const property =
		input.kind === "apartment"
			? apartmentProperty(input, evidence)
			: input.kind === "house"
				? houseProperty(input, evidence)
				: plotProperty(input, evidence);
	const uniqueness = scoreUniqueness(input, evidence);
	const risk = scoreRisk(input, evidence);
	const values: Record<ScoreComponentKey, { score: number; confidence: number }> = {
		value,
		market,
		location,
		property,
		uniqueness,
		risk,
	};
	const weights = WEIGHTS[input.kind];
	const components: ScoreComponentDto[] = (
		Object.keys(weights) as ScoreComponentKey[]
	).map((key) => ({
		key,
		label: COMPONENT_LABELS[key],
		score: Math.round(values[key].score),
		weight: weights[key],
		confidence: Math.round(values[key].confidence * 100) / 100,
	}));
	const raw = components.reduce(
		(sum, component) => sum + component.score * component.weight,
		0,
	);
	const confidence = components.reduce(
		(sum, component) => sum + component.confidence * component.weight,
		0,
	);
	const score = Math.round(
		clamp(50 + (raw - 50) * (0.7 + 0.3 * confidence), 0, 100),
	);
	const label =
		score >= 75
			? "bardzo atrakcyjna"
			: score >= 60
				? "atrakcyjna"
				: score >= 45
					? "neutralna"
					: score >= 30
						? "słaba"
						: "nieatrakcyjna";
	const strengths = evidence.positive
		.sort((a, b) => b.impact - a.impact)
		.slice(0, 5)
		.map((item) => item.text);
	const risks = evidence.negative
		.sort((a, b) => a.impact - b.impact)
		.slice(0, 5)
		.map((item) => item.text);
	const notes = [
		"Model regułowy z wagami segmentowymi; nie jest to wycena rzeczoznawcy ani dopasowany model ML.",
		"Widok i cechy z tekstu są oznaczone jako informacje z ogłoszenia; odległości liczone są z geometrii OSM.",
	];
	if (input.kind === "plot") {
		notes.push(
			"Przy działce sprawdź MPZP, dostęp do drogi i media; brak pełnych danych o zalewowości i wysokości terenu.",
		);
	}
	if (input.geo) {
		notes.push(
			"Bliskość kolei jest oceniana osobno od stacji: bardzo bliska linia może obniżać wynik przez hałas.",
		);
	}
	return {
		score,
		label,
		segment: input.kind,
		confidence: Math.round(confidence * 100) / 100,
		components,
		strengths,
		risks,
		notes,
		geo: input.geo,
	};
}
