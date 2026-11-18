/**
 * Condition/quality adjustment applied on top of a comparable-derived median.
 *
 * The valuation median answers "what do comparable offers sell for". It does
 * not answer "what is *this* flat worth", because the comparable pool mixes
 * renovated and neglected units. This module turns the physical facts we
 * already store (portal columns + LLM `listing_facts`) into one small
 * percentage correction with named reasons, so a "do remontu" tenement is not
 * valued like a renovated one and a new-build ground-floor flat with a lift,
 * parking and PV is not valued like a 1970s walk-up.
 *
 * ## Magnitudes and their sources (researched 2026-11)
 *
 * Condition deck (cumulative, relative to "stan dobry" = 0):
 *   - "do remontu" vs "wysoki standard": 20-25% spread across 18 voivodeship
 *     cities, 2023-Q1..2024-Q3 asking prices (nieruchomosci-online.pl).
 *     https://nieruchomosci-online.pl/porady/jak-stan-techniczny-wplywa-na-cene-mieszkania-17776.html
 *   - sub-steps from the same study: do remontu -> do odświeżenia 1-5%,
 *     do odświeżenia -> dobry 3-4%, dobry -> bardzo dobry 8-10%,
 *     bardzo dobry -> wysoki standard 3-5%.
 *   The deck below compresses that to four buckets (excellent +9,
 *   very_good +4, good 0, to_renovation -11) so the full span is 20%, the
 *   conservative end of the published 20-25% range, and entry/exit cancel.
 *   A wide "remont" vs "wysoki standard" 49% spread (em5.pl 2026) was not
 *   used: it compares location and building class too, not condition alone.
 *   https://em5.pl/blog/czy-warto-wyremontowac-mieszkanie-przed-sprzedaza
 *
 * Building age / technology:
 *   - "rok budowy" as a price feature: 8-12% across a whole market
 *     (serwiswykladzin.pl, 2026).
 *     https://serwiswykladzin.pl/mieszkania-z-pasja/wycena-mieszkania-w-warszawie
 *   - pre-war tenements vs post-2000 stock: up to 10% lower (niou.pl).
 *     https://niou.pl/wiek-budynku-a-cena-lokalu
 *   - houses depreciate ~1-1.5%/yr without a major renovation (kupiedom.pl
 *     quoting NBP), which is why the age curve is capped at 6 points and
 *     never becomes a straight-line 1%/yr discount.
 *     https://kupiedom.pl/wiek-budynku-a-wielkosc-rynkowa-jak-deprecjacja-nieruchomosci-wplywa-na-cene-domu-po-10-20-i-30-latach
 *   No source fixes exact sub-buckets; the curve below (new +3/+4, ~30y 0,
 *   pre-war -6) is a conservative reading of the 8-12% published span.
 *
 * Asking-to-transaction gap (used by asking-ratio.ts, not here):
 *   - market-wide asking vs transaction gap 9% (Katowice) to 17.2% (Gdańsk),
 *     real single-deal discount 2.2% (Kraków) to 5.4% (Łódź), Q2 2026
 *     (ilezametr.pl).
 *     https://ilezametr.pl/cena-ofertowa-a-transakcyjna-mieszkan-2026-luka-negocjacyjna
 *   - NBP BaRN: Kraków ~9%, Katowice ~8.7% (bknieruchomosci.pl, 2026).
 *     https://bknieruchomosci.pl/coraz-wieksza-roznica-miedzy-cenami-ofertowymi-a-transakcyjnymi-mieszkan
 *   - houses: 5-10% correction in a comparative valuation example
 *     (immohouse.pl).
 *     https://immohouse.pl/blog/poradnik-sprzedajacego/wycena-domu-kalkulator-metoda-porownawcza-i-kosztowa-krok-po-kroku
 *   - plots: 3-10% typical (dzialkopedia.pl), but plot offers can sit far
 *     above deeds (21.7% in one gmina); no reliable region-wide figure, so
 *     the fallback stays conservative at 0.90.
 *     https://dzialkopedia.pl/poradnik/ceny-i-wycena/cena-transakcyjna-a-ofertowa
 *
 * Legal status, defects and plot features have no published numeric deck. The
 * values below are deliberately small, individually capped, and the total is
 * clamped to ±15%: a correction that large is already at the edge of what a
 * comparative valuation can defend. Defect/encumbrance penalties are capped
 * together so a long ad list cannot drive the estimate to the clamp.
 *
 * Pure: no DB, no network, no clock (the caller passes `asOfYear` when it
 * wants determinism).
 */

import type { ScoredFacts } from "#/lib/llm/fact-access";

export type QualitySegment = "flat" | "house" | "plot";

export interface QualityReason {
	code: string;
	label: string;
	pct: number;
}

export interface QualityAdjustment {
	/** Total correction in percent, clamped to ±15. */
	pct: number;
	/** False when no quality signal was available (neutral 0). */
	known: boolean;
	reasons: QualityReason[];
}

export interface QualityInput {
	segment: QualitySegment;
	facts: ScoredFacts | null;
	buildYear?: number | null;
	buildingType?: string | null;
	buildingMaterial?: string | null;
	condition?: string | null;
	hasElevator?: boolean | null;
	floor?: string | null;
	floorCount?: number | null;
	plotType?: string | null;
	landUseClass?: string | null;
	zoningWz?: boolean | null;
	zoningPlanCount?: number | null;
	roadDistanceM?: number | null;
	slopeDeg?: number | null;
	floodRisk?: boolean | null;
	/** Calendar year used by the age curve. Defaults to the current year. */
	asOfYear?: number;
}

/** Hard ceiling on the total correction, percent. */
export const QUALITY_CLAMP_PCT = 15;

/**
 * Condition deck, percent, relative to "stan dobry". Mirrors the
 * nieruchomosci-online asking-price study described in the header: the
 * extremes span 20%, the conservative end of its 20-25% range.
 *
 * Keys are the `ScoredFacts` spelling; the snake_case portal strings are
 * normalized in `canonicalCondition`.
 */
const CONDITION_DECK: Record<string, number> = {
	excellent: 9,
	veryGood: 4,
	good: 0,
	toRenovation: -11,
};

const CONDITION_LABELS: Record<string, string> = {
	excellent: "wysoki standard",
	veryGood: "stan bardzo dobry",
	good: "stan dobry",
	toRenovation: "stan do remontu",
};

function canonicalCondition(value: string | null | undefined): string | null {
	if (!value) return null;
	switch (value.trim()) {
		case "excellent":
			return "excellent";
		case "very_good":
		case "veryGood":
			return "veryGood";
		case "good":
			return "good";
		case "to_renovation":
		case "toRenovation":
			return "toRenovation";
		default:
			return null;
	}
}

/** Parking/garage/elevator/amenity extras, each capped by the group below. */
const AMENITY_CAP = 2.5;
const PLOT_FLAT_CAP = 15;
const DEFECT_CAP = 4;
const ENCUMBRANCE_CAP = 2;

function firstNumber(
	...values: Array<number | null | undefined>
): number | null {
	for (const value of values) {
		if (value != null && Number.isFinite(value)) return value;
	}
	return null;
}

function firstString(
	...values: Array<string | null | undefined>
): string | null {
	for (const value of values) {
		if (value != null && value.trim().length > 0) return value.trim();
	}
	return null;
}

function firstBoolean(
	...values: Array<boolean | null | undefined>
): boolean | null {
	for (const value of values) {
		if (value != null) return value;
	}
	return null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Floors named as text ("4", "parter", "poddasze"). */
function parseFloor(value: string | null): number | null {
	if (!value) return null;
	const normalized = value.toLowerCase();
	if (normalized.includes("parter")) return 0;
	if (normalized.includes("poddasz") || normalized.includes("suterena")) {
		return null;
	}
	const match = normalized.match(/\d+/u);
	return match ? Number(match[0]) : null;
}

/** "4/5" -> the label stays honest about unknown media. */
function mediaLabel(connected: number, total: number): string {
	return `media na działce: ${connected}/${total}`;
}

function mediaPct(connected: number): number {
	if (connected <= 0) return -5;
	if (connected === 1) return -4;
	if (connected === 2) return -3;
	if (connected === 3) return -1.5;
	if (connected === 4) return 1;
	return 2;
}

function landUsePct(landUse: string | null): number {
	if (!landUse) return 0;
	const value = landUse.trim().toUpperCase();
	if (!value) return 0;
	if (value.startsWith("B")) return 1;
	if (value.startsWith("R")) return -1.5;
	if (value.startsWith("L")) return -4;
	if (value.startsWith("W")) return -5;
	if (value.startsWith("N")) return -2;
	if (value.startsWith("T")) return -1;
	return 0;
}

function plotTypePct(plotType: string | null): number {
	if (!plotType) return 0;
	switch (plotType.toLowerCase()) {
		case "budowlana":
		case "inwestycyjna":
			return 1;
		case "siedliskowa":
			return 0;
		case "rekreacyjna":
			return -1;
		case "rolna":
			return -2;
		case "lesna":
			return -3;
		default:
			return 0;
	}
}

function shapePct(shape: string | null): number {
	if (!shape) return 0;
	switch (shape.toLowerCase()) {
		case "regular":
			return 0;
		case "elongated":
			return -1;
		case "trapezoid":
			return -1;
		case "irregular":
			return -2;
		case "narrow":
			return -2.5;
		default:
			return 0;
	}
}

/**
 * Age curve for flats and houses, percent. Anchored so the median stock
 * (roughly 1990s-2010s) is neutral; the new-build premium and the pre-war
 * discount keep the 8-12% published span without extrapolating a straight
 * 1%/yr depreciation.
 */
function agePct(segment: "flat" | "house", age: number): number {
	if (age <= 5) return segment === "flat" ? 4 : 3;
	if (age <= 15) return 2;
	if (age <= 30) return 0;
	if (age <= 50) return -2;
	if (age <= 70) return -4;
	return -6;
}

function ageLabel(buildYear: number, age: number): string {
	if (age <= 5) return `budynek z ${buildYear} r.`;
	if (age > 70) return `budynek sprzed ${buildYear + 1} r.`;
	return `budynek z ${buildYear} r.`;
}

function truncate(value: string, max = 48): string {
	const clean = value.replace(/\s+/gu, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Build the correction for one offer. Reasons carry only non-zero components;
 * `known` is false when no usable signal was supplied at all.
 */
export function qualityAdjustment(input: QualityInput): QualityAdjustment {
	const facts = input.facts;
	const reasons: QualityReason[] = [];
	const asOfYear = input.asOfYear ?? new Date().getFullYear();

	const condition = canonicalCondition(
		firstString(input.condition, facts?.condition),
	);
	const buildYear = firstNumber(input.buildYear, facts?.buildYear);
	const buildingStyle = firstString(input.buildingType, facts?.buildingStyle);
	const buildingMaterial = firstString(input.buildingMaterial);
	const floorText = firstString(input.floor);
	const floor =
		(floorText ? parseFloor(floorText) : null) ?? firstNumber(facts?.floor);
	const floorCount = firstNumber(input.floorCount, facts?.floorCount);
	const hasElevator = firstBoolean(input.hasElevator);
	const plotType = firstString(input.plotType, facts?.plot?.type);
	const landUseClass = firstString(input.landUseClass);
	const zoningWz = firstBoolean(input.zoningWz, facts?.plot?.wz);
	const zoningPlanCount = firstNumber(input.zoningPlanCount);
	const roadDistanceM = firstNumber(input.roadDistanceM);
	const slopeDeg = firstNumber(input.slopeDeg);
	const floodRisk = firstBoolean(input.floodRisk);

	const hasSignal =
		condition != null ||
		buildYear != null ||
		buildingStyle != null ||
		buildingMaterial != null ||
		hasElevator != null ||
		floor != null ||
		floorCount != null ||
		plotType != null ||
		landUseClass != null ||
		zoningWz != null ||
		zoningPlanCount != null ||
		roadDistanceM != null ||
		slopeDeg != null ||
		floodRisk != null ||
		facts != null;

	if (!hasSignal) {
		return { pct: 0, known: false, reasons: [] };
	}

	const add = (code: string, label: string, pct: number) => {
		if (Math.abs(pct) < 0.05) return;
		reasons.push({ code, label, pct: round1(pct) });
	};

	if (input.segment === "plot") {
		// --- Plot: utilities, access, zoning, shape, terrain, flood --------
		const plot = facts?.plot ?? null;
		if (plot) {
			add(
				"plot_media",
				mediaLabel(plot.mediaCount, 5),
				mediaPct(plot.mediaCount),
			);
			if (plot.roadAccess) {
				const pct =
					plot.roadAccess === "public"
						? 1.5
						: plot.roadAccess === "private"
							? -1
							: -5;
				const label =
					plot.roadAccess === "public"
						? "droga publiczna"
						: plot.roadAccess === "private"
							? "droga prywatna"
							: "brak dojazdu";
				add("plot_road_access", label, pct);
			}
		}
		if (roadDistanceM != null) {
			const pct =
				roadDistanceM <= 50
					? 1
					: roadDistanceM <= 150
						? 0
						: roadDistanceM > 500
							? -2
							: 0;
			add(
				"plot_road_distance",
				`dojazd do drogi: ${Math.round(roadDistanceM)} m`,
				pct,
			);
		}
		if (zoningWz === true) {
			add("plot_wz", "decyzja WZ", 2);
		} else if (
			(zoningPlanCount ?? 0) > 0 ||
			plot?.mpzpSymbol != null ||
			plot?.mpzpPurpose != null
		) {
			add("plot_mpzp", "plan miejscowy", 1.5);
		}
		const landUse = landUsePct(landUseClass);
		if (landUse !== 0 && landUseClass) {
			add("plot_land_use", `klasa gruntu: ${landUseClass.trim()}`, landUse);
		}
		const typePct = plotTypePct(plotType);
		if (typePct !== 0 && plotType) {
			add("plot_type", `działka ${plotType.toLowerCase()}`, typePct);
		}
		const shape = plot?.shape ?? null;
		const shapeValue = shapePct(shape);
		if (shapeValue !== 0 && shape) {
			add("plot_shape", `kształt ${shape.toLowerCase()}`, shapeValue);
		}
		if (slopeDeg != null) {
			const pct = slopeDeg > 25 ? -3 : slopeDeg > 15 ? -1.5 : 0;
			add("plot_slope_deg", `spadek ${Math.round(slopeDeg)}°`, pct);
		} else if (plot?.slope === "steep") {
			add("plot_slope", "stromy stok", -3);
		} else if (plot?.slope === "gentle") {
			add("plot_slope", "łagodny spadek", -0.5);
		}
		if (floodRisk === true) {
			add("plot_flood", "teren zalewowy", -4);
		}
		const total = clamp(
			reasons.reduce((sum, reason) => sum + reason.pct, 0),
			-PLOT_FLAT_CAP,
			PLOT_FLAT_CAP,
		);
		return { pct: round1(total), known: true, reasons };
	}

	// --- Flat / house: condition ------------------------------------------
	const conditionValue = condition ? (CONDITION_DECK[condition] ?? 0) : 0;
	if (condition && CONDITION_LABELS[condition]) {
		add("condition", CONDITION_LABELS[condition] as string, conditionValue);
	}

	// --- Age and technology ------------------------------------------------
	if (buildYear != null && buildYear > 1800 && buildYear <= asOfYear + 2) {
		const age = Math.max(0, asOfYear - buildYear);
		add("age", ageLabel(buildYear, age), agePct(input.segment, age));
	}
	if (buildingStyle === "block" || buildingStyle === "largePanel") {
		add("building_panel", "wielka płyta", -2);
	} else if (buildingStyle === "tenement") {
		add("building_tenement", "kamienica", -1);
	}
	if (buildingMaterial === "wood") {
		add("building_material", "budynek drewniany", -1);
	}
	if (facts?.technology === "prefab" || facts?.technology === "framed") {
		add("technology", "technologia prefabrykowana", -1);
	}
	if (facts?.insulation === true) {
		add("insulation", "ocieplony budynek", 1);
	}

	// --- Installations and amenities (group-capped) ------------------------
	let amenity = 0;
	if (facts?.heatPump === true) amenity += 1;
	if (facts?.floorHeating === true) amenity += 0.5;
	if (facts?.recuperation === true) amenity += 0.5;
	if (facts?.airConditioning === true) amenity += 0.5;
	if (facts?.photovoltaics === true) amenity += 0.5;
	const parkingSpots = facts?.parkingSpots ?? 0;
	if (parkingSpots > 0) {
		amenity += Math.min(1.5, parkingSpots * 0.5);
	}
	amenity = clamp(amenity, 0, AMENITY_CAP);
	if (amenity > 0) {
		const labels: string[] = [];
		if (facts?.heatPump === true) labels.push("pompa ciepła");
		if (facts?.floorHeating === true) labels.push("ogrzewanie podłogowe");
		if (facts?.recuperation === true) labels.push("rekuperacja");
		if (facts?.airConditioning === true) labels.push("klimatyzacja");
		if (facts?.photovoltaics === true) labels.push("fotowoltaika");
		if (parkingSpots > 0) {
			labels.push(
				parkingSpots === 1
					? "miejsce postojowe"
					: `miejsca postojowe: ${parkingSpots}`,
			);
		}
		add(
			"amenities",
			labels.length > 0 ? labels.join(", ") : "udogodnienia",
			amenity,
		);
	}

	// --- Floor and lift ----------------------------------------------------
	if (hasElevator === false) {
		const targetFloor = floor ?? 1;
		if (
			targetFloor >= 4 ||
			(floorCount != null &&
				floorCount >= 5 &&
				targetFloor >= (floorCount - 1) / 2)
		) {
			add("no_lift_high_floor", `bez windy na ${targetFloor}. piętrze`, -2);
		}
	}

	// --- Legal status, encumbrances, defects, tenancy ----------------------
	const legalStatus = firstString(facts?.legalStatus);
	if (legalStatus === "perpetual_usufruct") {
		add("legal_leasehold", "użytkowanie wieczyste", -3);
	} else if (legalStatus === "share") {
		add("legal_share", "współwłasność", -2);
	}
	const encumbrances = facts?.encumbrances ?? [];
	if (encumbrances.length > 0) {
		const penalty = clamp(encumbrances.length * 1, 0, ENCUMBRANCE_CAP);
		add("encumbrances", `obciążenia: ${encumbrances.length}`, -penalty);
	}
	const defects = facts?.defects ?? [];
	if (defects.length > 0) {
		const penalty = clamp(defects.length * 1.5, 0, DEFECT_CAP);
		add("defects", `usterki: ${defects.length}`, -penalty);
		for (const defect of defects.slice(0, 4)) {
			// Named defects stay small and the group is capped; they make the
			// card explainable, not the correction larger.
			reasons.push({
				code: "defect",
				label: `usterka: ${truncate(defect)}`,
				pct: 0,
			});
		}
	}
	if (facts?.tenanted === true) {
		add("tenanted", "lokal wynajęty", -1.5);
	}

	const total = clamp(
		reasons.reduce((sum, reason) => sum + reason.pct, 0),
		-QUALITY_CLAMP_PCT,
		QUALITY_CLAMP_PCT,
	);
	return { pct: round1(total), known: true, reasons };
}
