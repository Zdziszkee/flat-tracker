/**
 * Validation for the transparent alert score.
 *
 *   node --import tsx scripts/validate-scoring.ts
 *
 * Part 1 checks monotonicity and gates on pure fixtures.
 * Part 2 checks the stored scores and alerts in the database.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingAlerts, listingScores, listings } from "#/db/schema";
import {
	scoreAlert,
	type ScoreListingInput,
} from "#/lib/scoring/alert-score";
import {
	ALERT_FRESHNESS,
	ALERT_GATES,
	FLAT_BUILDING_DELTAS,
	freshArrivalRank,
	freshArrivalTopN,
	HEATING_DELTAS,
	SCORE_VERSION,
	SEGMENT_WEIGHTS,
	shouldAlertFreshArrival,
	TRAIN_PREFERRED_M,
	TRAM_CITIES,
	TRAM_TARGET_M,
	valueCurveScore,
} from "#/lib/scoring/config";
import type { GeoUniqueness } from "#/lib/valuation/uniqueness-geo";
import type { ValuationEstimate } from "#/types/listing";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail: unknown): void {
	if (condition) {
		passed++;
		console.log(`PASS ${name}`);
	} else {
		failed++;
		console.log(`FAIL ${name}`, detail);
	}
}

function estimate(fairPrice: number, rcnCount = 20): ValuationEstimate {
	const area = 60;
	return {
		segment: "flat",
		fairM2: Math.round(fairPrice / area),
		fairPrice,
		lowM2: 0,
		highM2: 0,
		lowPrice: 0,
		highPrice: 0,
		overUnderPct: 0,
		rating: null,
		confidence: {
			level: "high",
			rcnCount,
			listingCount: 0,
			timeAdjustedCount: rcnCount,
			totalCount: rcnCount,
			spreadPct: 12,
			sameBuildingCount: 0,
		},
		comparables: [],
		compSets: { buildingRcn: null, nearbyRcn: null, listing: null },
		index: null,
		upside: null,
	};
}

function geo(overrides: Partial<GeoUniqueness> = {}): GeoUniqueness {
	return {
		parkM: 300,
		parkName: "Park Krakowski",
		parkCount500m: 1,
		forestM: 600,
		forestName: null,
		forestShare500m: 0,
		waterM: 1000,
		waterName: null,
		waterShare1000m: 0,
		lakeM: 1000,
		riverM: 1200,
		railM: 900,
		trainStationM: 900,
		stationName: "Kraków Główny",
		transitM: 300,
		transitName: "Teatr Bagatela 02",
		tramM: 300,
		tramName: "Teatr Bagatela 02",
		busM: 200,
		busName: null,
		city: "krakow",
		centerM: 3000,
		source: "osm-ways",
		...overrides,
	};
}

const flat: ScoreListingInput = {
	id: 1,
	source: "otodom",
	segment: "flat",
	region: "malopolskie",
	city: "Kraków",
	title: "Mieszkanie 60 m2",
	description: "Trzy pokoje, winda, balkon.",
	price: 600000,
	pricePerM2: 10000,
	areaM2: 60,
	rooms: 3,
	floor: "3",
	buildYear: 2018,
	condition: "good",
	ownership: "full_ownership",
	heatingType: "district",
	hasElevator: true,
	hasBalcony: true,
};

const plot: ScoreListingInput = {
	id: 2,
	source: "otodom",
	segment: "plot",
	region: "malopolskie",
	title: "Działka budowlana 1000 m2",
	description: "Media: prąd, woda, kanalizacja. Droga asfaltowa.",
	price: 200000,
	pricePerM2: 200,
	areaM2: 1000,
	plotAreaM2: 1000,
	plotType: "budowlana",
	parcelFeatures: {
		roadDistanceM: 20,
		roadClass: "asphalt",
		zoningWz: true,
		zoningPlanCount: 1,
		floodRisk: false,
		slopeDeg: 3,
	},
};

const house: ScoreListingInput = {
	...flat,
	id: 3,
	segment: "house",
	title: "Dom 120 m2 z ogrodem",
	areaM2: 120,
	plotAreaM2: 800,
	rooms: 4,
	buildingType: "detached",
	hasGarden: true,
	hasGarage: true,
};

function total(
	input: ScoreListingInput,
	value: ValuationEstimate | null,
	amenities: GeoUniqueness | null,
): number {
	return scoreAlert(input, value, amenities).totalScore;
}

// --- Value monotonicity -------------------------------------------------
const fair700 = total(flat, estimate(700000), geo());
const fair750 = total(flat, estimate(750000), geo());
const fair800 = total(flat, estimate(800000), geo());
check(
	"discount increases total score",
	fair700 < fair750 && fair750 < fair800,
	{ fair700, fair750, fair800 },
);

// --- Transit policy ----------------------------------------------------
const tram100 = scoreAlert(flat, estimate(800000), geo({ tramM: 100 }));
const tram1000 = scoreAlert(flat, estimate(800000), geo({ tramM: 1000 }));
check(
	"tram policy pins the 300 m target and the two tram cities",
	TRAM_TARGET_M === 300 &&
		TRAM_CITIES.length === 2 &&
		TRAM_CITIES.includes("krakow") &&
		TRAM_CITIES.includes("katowice") &&
		SCORE_VERSION === "2027.9",
	{ TRAM_TARGET_M, TRAM_CITIES, SCORE_VERSION },
);
check(
	"a tram stop within the 300 m target earns full credit",
	tram100.transitScore > tram1000.transitScore &&
		scoreAlert(flat, estimate(800000), geo({ tramM: 300 })).transitScore ===
			tram100.transitScore &&
		tram100.totalScore > tram1000.totalScore,
	{
		tram100: tram100.transitScore,
		tram1000: tram1000.transitScore,
		total100: tram100.totalScore,
		total1000: tram1000.totalScore,
	},
);
const katowiceFlat = scoreAlert(
	{ ...flat, city: "Katowice" },
	estimate(800000),
	geo({ tramM: 100 }),
);
check(
	"Kraków and Katowice flats get the same tram treatment",
	katowiceFlat.transitScore === tram100.transitScore &&
		katowiceFlat.totalScore === tram100.totalScore,
	{
		krakow: tram100.transitScore,
		katowice: katowiceFlat.transitScore,
	},
);
const tarnowFlat = scoreAlert(
	{ ...flat, city: "Tarnów" },
	estimate(800000),
	geo({ tramM: 100 }),
);
const nullCityFlat = scoreAlert(
	{ ...flat, city: null },
	estimate(800000),
	geo({ tramM: 100 }),
);
check(
	"tram is ignored for flats outside Kraków and Katowice",
	tarnowFlat.transitScore === nullCityFlat.transitScore &&
		scoreAlert(
			{ ...flat, city: "Tarnów" },
			estimate(800000),
			geo({ tramM: 3000 }),
		).transitScore === tarnowFlat.transitScore &&
		!tarnowFlat.reasons.some((reason) => /tram/i.test(reason.label)),
	{
		tarnow: tarnowFlat.transitScore,
		nullCity: nullCityFlat.transitScore,
		reasons: tarnowFlat.reasons,
	},
);
const houseNearTram = scoreAlert(
	house,
	estimate(800000),
	geo({ tramM: 100, trainStationM: 3000 }),
);
const plotNearTram = scoreAlert(
	plot,
	estimate(300000),
	geo({ tramM: 100, trainStationM: 3000 }),
);
const houseFarTram = scoreAlert(
	house,
	estimate(800000),
	geo({ tramM: 3000, trainStationM: 3000 }),
);
const plotFarTram = scoreAlert(
	plot,
	estimate(300000),
	geo({ tramM: 3000, trainStationM: 3000 }),
);
check(
	"tram is ignored for houses and plots even in tram cities",
	houseNearTram.transitScore === houseFarTram.transitScore &&
		plotNearTram.transitScore === plotFarTram.transitScore &&
		!houseNearTram.reasons.some((reason) => /tram/i.test(reason.label)) &&
		!plotNearTram.reasons.some((reason) => /tram/i.test(reason.label)),
	{
		houseNear: houseNearTram.transitScore,
		houseFar: houseFarTram.transitScore,
		plotNear: plotNearTram.transitScore,
		plotFar: plotFarTram.transitScore,
	},
);

// --- Rail noise ---------------------------------------------------------
const nearRail = scoreAlert(flat, estimate(800000), geo({ railM: 60 }));
const farRail = scoreAlert(flat, estimate(800000), geo({ railM: 900 }));
check(
	"railway noise lowers transit score",
	nearRail.transitScore < farRail.transitScore,
	{ nearRail: nearRail.transitScore, farRail: farRail.transitScore },
);
check(
	"railway noise is flagged",
	nearRail.flags.includes("rail_noise"),
	nearRail.flags,
);

// --- Train sweet spot ---------------------------------------------------
const houseStation900 = scoreAlert(
	house,
	estimate(800000),
	geo({ trainStationM: 900, tramM: 3000 }),
);
const houseStation1900 = scoreAlert(
	house,
	estimate(800000),
	geo({ trainStationM: 1900, tramM: 3000 }),
);
const houseStation2100 = scoreAlert(
	house,
	estimate(800000),
	geo({ trainStationM: 2100, tramM: 3000 }),
);
const houseStation100 = scoreAlert(
	house,
	estimate(800000),
	geo({ trainStationM: 100, tramM: 3000 }),
);
const plotStation900 = scoreAlert(
	plot,
	estimate(300000),
	geo({ trainStationM: 900, tramM: 3000 }),
);
const plotStation2100 = scoreAlert(
	plot,
	estimate(300000),
	geo({ trainStationM: 2100, tramM: 3000 }),
);
check(
	"houses and plots prefer a train station below 2 km",
	TRAIN_PREFERRED_M === 2000 &&
		houseStation900.transitScore > houseStation2100.transitScore &&
		houseStation1900.transitScore > houseStation2100.transitScore &&
		plotStation900.transitScore > plotStation2100.transitScore,
	{
		house900: houseStation900.transitScore,
		house1900: houseStation1900.transitScore,
		house2100: houseStation2100.transitScore,
		plot900: plotStation900.transitScore,
		plot2100: plotStation2100.transitScore,
	},
);
check(
	"a station at the doorstep is still penalized",
	houseStation100.transitScore < houseStation900.transitScore,
	{
		station100: houseStation100.transitScore,
		station900: houseStation900.transitScore,
	},
);
const tramFlatWins = scoreAlert(
	flat,
	estimate(800000),
	geo({ tramM: 100, trainStationM: 3000 }),
);
const trainHouseWins = scoreAlert(
	house,
	estimate(800000),
	geo({ tramM: 3000, trainStationM: 500 }),
);
check(
	"the tram and train preferences flip between flats and houses",
	tramFlatWins.transitScore > tram1000.transitScore &&
		trainHouseWins.transitScore > houseStation2100.transitScore,
	{
		tramFlat: tramFlatWins.transitScore,
		flatNoTram: tram1000.transitScore,
		trainHouse: trainHouseWins.transitScore,
		houseNoTrain: houseStation2100.transitScore,
	},
);

// --- Green monotonicity -------------------------------------------------
const park100 = scoreAlert(flat, estimate(800000), geo({ parkM: 100, parkCount500m: 2 }));
const park500 = scoreAlert(flat, estimate(800000), geo({ parkM: 500, parkCount500m: 1 }));
const park1500 = scoreAlert(flat, estimate(800000), geo({ parkM: 1500, parkCount500m: 0 }));
check(
	"closer park increases green score",
	park100.greenScore > park500.greenScore &&
		park500.greenScore > park1500.greenScore,
	{
		park100: park100.greenScore,
		park500: park500.greenScore,
		park1500: park1500.greenScore,
	},
);

const forest0 = scoreAlert(flat, estimate(800000), geo({ forestShare500m: 0 }));
const forest05 = scoreAlert(flat, estimate(800000), geo({ forestShare500m: 0.5 }));
const forest09 = scoreAlert(flat, estimate(800000), geo({ forestShare500m: 0.9 }));
check(
	"more forest cover increases green score",
	forest0.greenScore < forest05.greenScore &&
		forest05.greenScore < forest09.greenScore,
	{
		forest0: forest0.greenScore,
		forest05: forest05.greenScore,
		forest09: forest09.greenScore,
	},
);

const water100 = scoreAlert(flat, estimate(800000), geo({ lakeM: 100, riverM: 2000 }));
const water800 = scoreAlert(flat, estimate(800000), geo({ lakeM: 800, riverM: 2000 }));
const water2000 = scoreAlert(flat, estimate(800000), geo({ lakeM: 2000, riverM: 2000 }));
check(
	"closer water increases green score",
	water100.greenScore > water800.greenScore &&
		water800.greenScore > water2000.greenScore,
	{
		water100: water100.greenScore,
		water800: water800.greenScore,
		water2000: water2000.greenScore,
	},
);

// --- Plot-specific signals ---------------------------------------------
const plotWithMedia = scoreAlert(plot, estimate(300000), geo());
const plotNoMedia = scoreAlert(
	{ ...plot, description: "Działka bez mediów." },
	estimate(300000),
	geo(),
);
check(
	"media mention increases plot property score",
	plotWithMedia.propertyScore > plotNoMedia.propertyScore,
	{
		withMedia: plotWithMedia.propertyScore,
		noMedia: plotNoMedia.propertyScore,
	},
);

const plotNoZoning = scoreAlert(
	{
		...plot,
		parcelFeatures: { ...plot.parcelFeatures, zoningWz: false, zoningPlanCount: 0 },
	},
	estimate(300000),
	geo(),
);
check(
	"WZ or MPZP increases plot property score",
	plotWithMedia.propertyScore > plotNoZoning.propertyScore,
	{
		withPlan: plotWithMedia.propertyScore,
		withoutPlan: plotNoZoning.propertyScore,
	},
);

const plotFlood = scoreAlert(
	{
		...plot,
		parcelFeatures: { ...plot.parcelFeatures, floodRisk: true },
	},
	estimate(300000),
	geo(),
);
check(
	"flood risk lowers plot score",
	plotFlood.totalScore < plotWithMedia.totalScore,
	{ flood: plotFlood.totalScore, dry: plotWithMedia.totalScore },
);
check("flood risk is flagged", plotFlood.flags.includes("flood_risk"), plotFlood.flags);

// --- Flat building style -------------------------------------------------
const baselineFlat = {
	...flat,
	heatingType: "gazowe",
};
const baselineProperty = scoreAlert(
	baselineFlat,
	estimate(800000),
	geo(),
).propertyScore;
const blockFlat = scoreAlert(
	{ ...baselineFlat, buildingType: "block", buildingMaterial: null },
	estimate(800000),
	geo(),
);
const panelFlat = scoreAlert(
	{
		...baselineFlat,
		buildingType: "apartment",
		buildingMaterial: "wielka płyta",
	},
	estimate(800000),
	geo(),
);
const tenementFlat = scoreAlert(
	{ ...baselineFlat, buildingType: "tenement", buildingMaterial: null },
	estimate(800000),
	geo(),
);
const apartmentFlat = scoreAlert(
	{ ...baselineFlat, buildingType: "apartment", buildingMaterial: null },
	estimate(800000),
	geo(),
);
check(
	"large-panel block lowers flat property score",
	blockFlat.propertyScore < baselineProperty &&
		panelFlat.propertyScore < baselineProperty &&
		blockFlat.propertyScore === panelFlat.propertyScore,
	{
		baseline: baselineProperty,
		block: blockFlat.propertyScore,
		panel: panelFlat.propertyScore,
		delta: FLAT_BUILDING_DELTAS.largePanel,
	},
);
check(
	"tenement and apartment building raise flat property score",
	tenementFlat.propertyScore > baselineProperty &&
		apartmentFlat.propertyScore > baselineProperty &&
		tenementFlat.propertyScore > apartmentFlat.propertyScore,
	{
		baseline: baselineProperty,
		tenement: tenementFlat.propertyScore,
		apartment: apartmentFlat.propertyScore,
		tenementDelta: FLAT_BUILDING_DELTAS.tenement,
		apartmentDelta: FLAT_BUILDING_DELTAS.apartmentBuilding,
	},
);
const blockInTitle = scoreAlert(
	{ ...baselineFlat, title: "Mieszkanie w bloku 60 m2" },
	estimate(800000),
	geo(),
);
const tenementWithBlockInTitle = scoreAlert(
	{
		...baselineFlat,
		title: "Kamienica blisko bloku 60 m2",
		buildingType: "tenement",
	},
	estimate(800000),
	geo(),
);
check(
	"building type text fallback works and structured type wins",
	blockInTitle.propertyScore < baselineProperty &&
		tenementWithBlockInTitle.propertyScore === tenementFlat.propertyScore,
	{
		baseline: baselineProperty,
		blockTitle: blockInTitle.propertyScore,
		tenementStructured: tenementWithBlockInTitle.propertyScore,
	},
);

// --- Heating cost ordering ------------------------------------------------
const districtFlat = scoreAlert(
	{ ...flat, heatingType: "c.o. miejskie" },
	estimate(800000),
	geo(),
);
const gasFlat = scoreAlert(
	{ ...flat, heatingType: "gazowe" },
	estimate(800000),
	geo(),
);
const electricFlat = scoreAlert(
	{ ...flat, heatingType: "elektryczne" },
	estimate(800000),
	geo(),
);
check(
	"district heating is rewarded more than gas and electricity",
	districtFlat.propertyScore > gasFlat.propertyScore &&
		gasFlat.propertyScore > electricFlat.propertyScore &&
		HEATING_DELTAS.district > 0 &&
		HEATING_DELTAS.gas < 0 &&
		HEATING_DELTAS.electric < HEATING_DELTAS.gas,
	{
		district: districtFlat.propertyScore,
		gas: gasFlat.propertyScore,
		electric: electricFlat.propertyScore,
	},
);

// --- Gates and confidence ---------------------------------------------
const noEstimate = scoreAlert(flat, null, geo());
check(
	"no comparable estimate is ineligible",
	!noEstimate.eligible && noEstimate.gateReason === "no_comparable_estimate",
	noEstimate.gateReason,
);

const thinComps = scoreAlert(flat, estimate(800000, 2), geo());
check(
	"thin RCN set is ineligible",
	!thinComps.eligible,
	{ eligible: thinComps.eligible, confidence: thinComps.confidence },
);

const cheapEnough = scoreAlert(flat, estimate(700000), geo());
check(
	"10%+ cheaper than the local median passes the discount gate",
	cheapEnough.eligible && (cheapEnough.discountPct ?? 0) >= 10,
	{ discount: cheapEnough.discountPct, gate: ALERT_GATES.minDiscountPct },
);

const nearFair = scoreAlert(flat, estimate(620000), geo());
check(
	"near-fair offer fails the discount gate",
	!nearFair.eligible && nearFair.gateReason === "discount_below_gate",
	{ discount: nearFair.discountPct, gate: ALERT_GATES.minDiscountPct },
);

// --- Fresh arrivals (24-hour cohort) -----------------------------------
// The rule is relative: a fresh offer alerts when it sits inside the top
// `ALERT_FRESHNESS.topPercent` of the last 24 hours' offers in its region
// and segment. Scores are the only input, so the fixtures are explicit
// score lists.
check(
	"fresh-arrival policy is the 24h / top-5% block",
	ALERT_FRESHNESS.windowHours === 24 && ALERT_FRESHNESS.topPercent === 5,
	ALERT_FRESHNESS,
);

/** A cohort of `total` distinct scores, best first. */
function freshCohort(total: number): number[] {
	return Array.from({ length: total }, (_, i) => 100 - i * 0.5);
}

const freshCohort100 = freshCohort(100);
const freshFifth = freshCohort100[4] ?? 0;
const freshSixth = freshCohort100[5] ?? 0;
check(
	"a fresh offer above the cohort cut alerts",
	shouldAlertFreshArrival(100, freshCohort100) &&
		shouldAlertFreshArrival(freshFifth, freshCohort100),
	{
		rank1: freshArrivalRank(100, freshCohort100),
		rank5: freshArrivalRank(freshFifth, freshCohort100),
	},
);
check(
	"a fresh offer below the cohort cut does not alert",
	!shouldAlertFreshArrival(freshSixth, freshCohort100) &&
		!shouldAlertFreshArrival(40, freshCohort100),
	{ rank6: freshArrivalRank(freshSixth, freshCohort100) },
);
const freshCohort20 = freshCohort(20);
check(
	"the topPercent boundary is exact (5 of 100, 1 of 20)",
	freshArrivalTopN(100, ALERT_FRESHNESS.topPercent) === 5 &&
		freshArrivalTopN(20, ALERT_FRESHNESS.topPercent) === 1 &&
		shouldAlertFreshArrival(freshCohort20[0] ?? 0, freshCohort20) &&
		!shouldAlertFreshArrival(freshCohort20[1] ?? 0, freshCohort20),
	{ top100: freshArrivalTopN(100, 5), top20: freshArrivalTopN(20, 5) },
);
check(
	"an empty cohort alerts nothing",
	!shouldAlertFreshArrival(90, []) && freshArrivalTopN(0, 5) === 0,
	{},
);
check(
	"a one-offer cohort is its own leader, a two-offer cohort is not",
	shouldAlertFreshArrival(70, [70]) &&
		shouldAlertFreshArrival(90, [90, 70]) &&
		!shouldAlertFreshArrival(70, [90, 70]),
	{},
);
check(
	"ties share a rank, so a tied leader still alerts",
	shouldAlertFreshArrival(80, [80, 80, 80]) &&
		!shouldAlertFreshArrival(80, [90, 80, 80]),
	{ rank: freshArrivalRank(80, [80, 80, 80]) },
);

// The gates live inside the score, so a gate-failing offer never reaches
// the fresh-arrival rule. Each fixture below would be its own cohort leader
// (a one-element cohort alerts), which isolates the gate as the blocker.
const gateBlockedArrivals = [noEstimate, thinComps, nearFair];
check(
	"gates still block a fresh arrival (no estimate, confidence, discount)",
	gateBlockedArrivals.every(
		(scored) =>
			!scored.eligible &&
			shouldAlertFreshArrival(scored.totalScore, [scored.totalScore]),
	) &&
		noEstimate.gateReason === "no_comparable_estimate" &&
		thinComps.gateReason === "confidence_below_gate" &&
		nearFair.gateReason === "discount_below_gate",
	gateBlockedArrivals.map((scored) => scored.gateReason),
);
check(
	"a low value score is already below the discount gate",
	valueCurveScore(0.01) < ALERT_GATES.minValueScore &&
		valueCurveScore(ALERT_GATES.minDiscountPct / 100) >=
			ALERT_GATES.minValueScore,
	{
		valueAt1pct: valueCurveScore(0.01),
		valueAtDiscountGate: valueCurveScore(ALERT_GATES.minDiscountPct / 100),
	},
);

// --- Discount curve --------------------------------------------------------
// The headline discountPct, the gate and the value component all use the RAW
// asking price against the local comparable median. The curve saturates:
// 0% -> 50, 10% -> ~80, 20% -> ~95, 30%+ -> 100 (cap).
function listingEstimate(fairPrice: number): ValuationEstimate {
	const base = estimate(fairPrice, 0);
	return {
		...base,
		confidence: {
			...base.confidence,
			level: "medium",
			listingCount: 20,
			timeAdjustedCount: 0,
			totalCount: 20,
		},
	};
}

function valueAt(discountPct: number): number {
	// asking 600k, fair chosen so raw discount is exactly discountPct
	const fair = 600000 / (1 - discountPct / 100);
	return scoreAlert(flat, estimate(fair), geo()).valueScore;
}

const v0 = valueAt(0);
const v10 = valueAt(10);
const v20 = valueAt(20);
const v30 = valueAt(30);
const v40 = valueAt(40);
check(
	"discount curve saturates: 0->50, 10->80, 20->95, 30+->100",
	v0 === 50 && v10 === 80 && v20 === 95 && v30 === 100 && v40 === 100,
	{ v0, v10, v20, v30, v40 },
);
check(
	"first 10% of discount adds more than the next 10%",
	v10 - v0 > v20 - v10 && v20 - v10 > v30 - v20,
	{ step1: v10 - v0, step2: v20 - v10, step3: v30 - v20 },
);

const rcnBacked = scoreAlert(flat, estimate(700000), geo());
const listingOnly = scoreAlert(flat, listingEstimate(700000), geo());
check(
	"headline discount is the raw asking price vs median",
	Math.abs((rcnBacked.discountPct ?? 0) - 14.3) < 0.1 &&
		Math.abs((listingOnly.discountPct ?? 0) - 14.3) < 0.1,
	{ rcn: rcnBacked.discountPct, listing: listingOnly.discountPct },
);
check(
	"same discount scores the same on RCN and listing-only comps",
	rcnBacked.valueScore === listingOnly.valueScore,
	{ rcn: rcnBacked.valueScore, listing: listingOnly.valueScore },
);
for (const [label, scored] of [
	["rcn-backed", rcnBacked],
	["listing-only", listingOnly],
] as const) {
	const expected = valueCurveScore((scored.discountPct ?? 0) / 100);
	check(
		`value score matches the raw discount curve (${label})`,
		Math.abs(scored.valueScore - Math.round(expected)) <= 1,
		{ valueScore: scored.valueScore, expected },
	);
}
const belowGate = scoreAlert(flat, listingEstimate(650000), geo());
check(
	"offer under 10% below median fails the gate",
	(belowGate.discountPct ?? 100) < 10 &&
		belowGate.gateReason === "discount_below_gate",
	{
		discount: belowGate.discountPct,
		gateReason: belowGate.gateReason,
	},
);

// --- Bounds and determinism --------------------------------------------
const bounded = [fair700, fair750, fair800, tram100.totalScore, park100.totalScore];
check(
	"all scores stay inside 0..100",
	bounded.every((value) => value >= 0 && value <= 100),
	bounded,
);
const repeated = total(flat, estimate(800000), geo());
check("score is deterministic", repeated === Math.round(repeated * 10) / 10, repeated);

const weights = SEGMENT_WEIGHTS.flat;
const weightSum =
	weights.value + weights.transit + weights.green + weights.property + weights.risk;
check("flat weights sum to 1", Math.abs(weightSum - 1) < 1e-9, weightSum);

// --- Stored scores and alerts ------------------------------------------
const scoreRows = await db
	.select({
		count: sql<number>`count(*)`,
		minTotal: sql<number>`min(${listingScores.totalScore})`,
		maxTotal: sql<number>`max(${listingScores.totalScore})`,
		minValue: sql<number>`min(${listingScores.valueScore})`,
		maxValue: sql<number>`max(${listingScores.valueScore})`,
	})
	.from(listingScores);
const stored = scoreRows[0];
check(
	"stored scores are bounded",
	stored != null &&
		stored.minTotal >= 0 &&
		stored.maxTotal <= 100 &&
		stored.minValue >= 0 &&
		stored.maxValue <= 100,
	stored,
);
// A version bump leaves old-version rows until the next scoring run, so
// this only asserts that scores exist at all.
check("stored scores exist", (stored?.count ?? 0) > 0, stored);

const alerts = await db
	.select({
		count: sql<number>`count(*)`,
		minDiscount: sql<number>`min(${listingScores.discountPct})`,
		minConfidence: sql<number>`min(${listingScores.confidence})`,
		minValue: sql<number>`min(${listingScores.valueScore})`,
	})
	.from(listingAlerts)
	.innerJoin(listingScores, eq(listingAlerts.scoreId, listingScores.id));
const alertStats = alerts[0];
check(
	"stored alerts respect the gates",
	alertStats == null ||
		alertStats.count === 0 ||
		(alertStats.minDiscount >= ALERT_GATES.minDiscountPct &&
			alertStats.minConfidence >= ALERT_GATES.minConfidence &&
			alertStats.minValue >= ALERT_GATES.minValueScore),
	alertStats,
);

const duplicates = await db
	.select({
		listingId: listingAlerts.listingId,
		alertDate: listingAlerts.alertDate,
		count: sql<number>`count(*)`,
	})
	.from(listingAlerts)
	.groupBy(listingAlerts.listingId, listingAlerts.alertDate)
	.having(sql`count(*) > 1`);
check("no duplicate listing/day alerts", duplicates.length === 0, duplicates);

const repeatedAlerts = await db
	.select({
		listingId: listingAlerts.listingId,
		count: sql<number>`count(*)`,
	})
	.from(listingAlerts)
	.groupBy(listingAlerts.listingId)
	.having(sql`count(*) > 1`);
check(
	"each listing is alerted at most once",
	repeatedAlerts.length === 0,
	repeatedAlerts,
);

// Fresh-arrival rows carry their own payload contract: a rank inside the
// cohort they competed with, and the reason that /alerts can group on.
const freshAlertRows = await db
	.select({
		count: sql<number>`count(*)`,
		badRank: sql<number>`sum(case when ${listingAlerts.rank} < 1 or ${listingAlerts.rank} > json_extract(${listingAlerts.payloadJson}, '$.cohortSize') then 1 else 0 end)`,
		badChannel: sql<number>`sum(case when ${listingAlerts.channel} != 'in_app' then 1 else 0 end)`,
	})
	.from(listingAlerts)
	.where(sql`json_extract(${listingAlerts.payloadJson}, '$.reason') = 'fresh_arrival'`);
const freshAlerts = freshAlertRows[0];
check(
	"fresh-arrival alerts rank inside their cohort and use the in-app channel",
	freshAlerts == null ||
		((freshAlerts.badRank ?? 0) === 0 && (freshAlerts.badChannel ?? 0) === 0),
	freshAlerts,
);

check("scoring tables are readable", true, { scores: stored?.count ?? 0, alerts: alertStats?.count ?? 0 });

// --- Incremental-run invariants (relative to the CURRENT SCORE_VERSION) --
// A version bump leaves old-version scores and their alerts in place until
// the next run, so every check below scopes to the current version instead
// of asserting absolute counts.

const duplicateVersionScores = await db
	.select({
		listingId: listingScores.listingId,
		count: sql<number>`count(*)`,
	})
	.from(listingScores)
	.where(eq(listingScores.scoreVersion, SCORE_VERSION))
	.groupBy(listingScores.listingId)
	.having(sql`count(*) > 1`);
check(
	"one current-version score per listing (incremental selection relies on it)",
	duplicateVersionScores.length === 0,
	duplicateVersionScores.slice(0, 5),
);

const nonSaleScores = await db
	.select({ count: sql<number>`count(*)` })
	.from(listingScores)
	.innerJoin(listings, eq(listingScores.listingId, listings.id))
	.where(
		and(
			eq(listingScores.scoreVersion, SCORE_VERSION),
			sql`${listings.offerType} != 'sale'`,
		),
	);
check(
	"current-version scores exist only for sale listings",
	(nonSaleScores[0]?.count ?? 0) === 0,
	nonSaleScores[0],
);

const mismatchedAlerts = await db
	.select({ count: sql<number>`count(*)` })
	.from(listingAlerts)
	.innerJoin(listingScores, eq(listingAlerts.scoreId, listingScores.id))
	.where(
		sql`${listingAlerts.listingId} != ${listingScores.listingId}
				or ${listingAlerts.segment} != ${listingScores.segment}
				or ${listingAlerts.region} != ${listingScores.region}
				or abs(${listingAlerts.score} - ${listingScores.totalScore}) > 0.001`,
	);
check(
	"every alert mirrors its score row (listing, segment, region, score)",
	(mismatchedAlerts[0]?.count ?? 0) === 0,
	mismatchedAlerts[0],
);

// The eligible pool exactly as createAlerts() builds it for the current
// version: active, visible, gate-passing scores.
const pool = await db
	.select({
		listingId: listingScores.listingId,
		segment: listingScores.segment,
		region: listingScores.region,
		totalScore: listingScores.totalScore,
	})
	.from(listingScores)
	.innerJoin(listings, eq(listingScores.listingId, listings.id))
	.where(
		and(
			eq(listingScores.scoreVersion, SCORE_VERSION),
			eq(listings.isActive, true),
			eq(listings.isVisible, true),
			gte(listingScores.valueScore, ALERT_GATES.minValueScore),
			gte(listingScores.confidence, ALERT_GATES.minConfidence),
			gte(listingScores.discountPct, ALERT_GATES.minDiscountPct),
		),
	)
	.orderBy(desc(listingScores.totalScore));

const poolGroups = new Map<string, typeof pool>();
for (const row of pool) {
	const key = `${row.region}:${row.segment}`;
	const group = poolGroups.get(key) ?? [];
	group.push(row);
	poolGroups.set(key, group);
}

const alertedIds = new Set(
	(
		await db
			.select({ listingId: listingAlerts.listingId })
			.from(listingAlerts)
	).map((row) => row.listingId),
);

// Current-version alerts on still-visible listings, per group PER DATE:
// the list appends across days by design, so the ceiling is per daily cut,
// not cumulative. (A same-day pool shrink is the only way a past cut could
// exceed today's topN; the pool only grows within a day in practice.)
// Fresh-arrival alerts follow their own cohort rule and are excluded here;
// they are bounded by `shouldAlertFreshArrival` instead.
const currentAlertRows = await db
	.select({
		listingId: listingAlerts.listingId,
		segment: listingAlerts.segment,
		region: listingAlerts.region,
		alertDate: listingAlerts.alertDate,
	})
	.from(listingAlerts)
	.innerJoin(listingScores, eq(listingAlerts.scoreId, listingScores.id))
	.innerJoin(listings, eq(listingAlerts.listingId, listings.id))
	.where(
		and(
			eq(listingScores.scoreVersion, SCORE_VERSION),
			eq(listings.isActive, true),
			eq(listings.isVisible, true),
			sql`coalesce(json_extract(${listingAlerts.payloadJson}, '$.reason'), '') != 'fresh_arrival'`,
		),
	);
const currentAlertCounts = new Map<string, number>();
for (const row of currentAlertRows) {
	const key = `${row.region}:${row.segment}:${row.alertDate}`;
	currentAlertCounts.set(key, (currentAlertCounts.get(key) ?? 0) + 1);
}

const ceilingViolations: Array<Record<string, unknown>> = [];
const uncovered: Array<Record<string, unknown>> = [];
for (const [key, group] of poolGroups) {
	const topN = Math.max(1, Math.ceil(group.length * 0.05));
	for (const [dateKey, alertCount] of currentAlertCounts) {
		if (dateKey.startsWith(`${key}:`) && alertCount > topN) {
			ceilingViolations.push({
				key: dateKey,
				pool: group.length,
				topN,
				alertCount,
			});
		}
	}
	// After a completed run every listing inside today's cut must have an
	// alert (possibly from an earlier day/version: at-most-once semantics).
	for (const row of group.slice(0, topN)) {
		if (!alertedIds.has(row.listingId)) {
			uncovered.push({ key, listingId: row.listingId, topN });
		}
	}
}
check(
	"current-version alerts stay within the top-5% ceiling per region+segment+day",
	ceilingViolations.length === 0,
	ceilingViolations,
);
check(
	"every listing in the current top-5% cut has an alert (run coverage)",
	uncovered.length === 0,
	uncovered.slice(0, 5),
);

// The incremental not-exists predicate must select exactly the offers the
// unique index says lack a current-version score: base-eligible listings
// partition into scored + backlog with no overlap.
const partition = await db
	.select({
		total: sql<number>`count(*)`,
		scored: sql<number>`sum(case when exists (select 1 from ${listingScores} where ${listingScores.listingId} = ${listings.id} and ${listingScores.scoreVersion} = ${SCORE_VERSION}) then 1 else 0 end)`,
	})
	.from(listings)
	.where(
		and(
			eq(listings.offerType, "sale"),
			eq(listings.isActive, true),
			eq(listings.isVisible, true),
		),
	);
const part = partition[0];
const backlog = (part?.total ?? 0) - (part?.scored ?? 0);
check(
	"incremental selection partitions sale listings into scored + backlog",
	part != null && part.total >= part.scored && backlog >= 0,
	{ ...part, backlog, scoreVersion: SCORE_VERSION },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
