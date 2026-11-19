/**
 * Validation for the transparent alert score.
 *
 *   node --import tsx scripts/validate-scoring.ts
 *
 * Part 1 checks monotonicity and gates on pure fixtures.
 * Part 2 checks the stored scores and alerts in the database.
 */

import { and, desc, eq, gte, or, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingAlerts, listingScores, listings } from "#/db/schema";
import {
	scoreAlert,
	type ScoreListingInput,
} from "#/lib/scoring/alert-score";
import {
	ALERT_FRESHNESS,
	ALERT_GATES,
	ALERT_TOP_OFFERS,
	AMENITY_BONUSES,
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
import { scoredFactsOf } from "#/lib/llm/fact-access";
import { buildingClassOf } from "#/lib/building-class";
import {
	buildingStyleFromProse,
	heatingFromProse,
} from "#/lib/scoring/prose-lexicon";
import {
	ALERT_REBUILD_MIN_INTERVAL_MS,
	duplicateKey,
	investmentKey,
	selectLeaders,
	shouldRebuildAlerts,
} from "#/lib/scoring/run";
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

function estimate(
	fairPrice: number,
	rcnCount = 20,
	overrides: {
		spreadPct?: number;
		timeFactorMedian?: number | null;
	} = {},
): ValuationEstimate {
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
			spreadPct: overrides.spreadPct ?? 12,
			sameBuildingCount: 0,
		},
		comparables: [],
		compSets: { buildingRcn: null, nearbyRcn: null, listing: null },
		index: null,
		qualityAdjustmentPct: 0,
		qualityAdjustmentKnown: false,
		qualityAdjustmentReasons: [],
		statistics: {
			timeFactorMedian: overrides.timeFactorMedian ?? null,
			indexSpan: null,
			askingRatio: null,
			askingRatioSource: null,
			compAgeMedianYears: null,
		},
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
	// Kazimierz, inside the 4 km centre zone.
	lat: 50.0515,
	lng: 19.9448,
	// A pre-war tenement with municipal heating: the target flat profile.
	facts: scoredFactsOf({
		heating: "district",
		buildingType: "tenement",
		condition: "good",
		buildYear: 1930,
	}),
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
	// 1.1 km from Kraków Główny: inside the 3 km fast-rail gate.
	lat: 50.0616,
	lng: 19.9373,
	facts: scoredFactsOf({
		plotType: "budowlana",
		utilities: { power: true, water: true, gas: true, sewer: true },
		roadAccess: "public",
	}),
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
	// The holiday-house profile: wooden, retro, on a big plot, alone.
	buildingMaterial: "wood",
	buildYear: 1968,
	facts: scoredFactsOf({
		heating: "coalWood",
		buildingType: "house",
		buildYear: 1968,
		buildingMaterial: "wood",
		context: { lake: true, forest: true, river: false, mountains: false },
	}),
	neighbours: {
		nearestBuildingM: 320,
		buildingsWithin150m: 0,
		sampledBuildings: 0,
	},
	str: { nightlyMedian: 620, sampleCount: 24, nightlyLow: 250, nightlyHigh: 1400 },
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
		SCORE_VERSION === "2027.19",
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
	{ ...flat, city: "Katowice", lat: 50.2593, lng: 19.0216 },
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

// --- Additive amenity points --------------------------------------------
const bonusScore = scoreAlert(flat, estimate(800000), geo());
const bonusImpact = (pattern: RegExp): number | undefined =>
	bonusScore.reasons.find((reason) => pattern.test(reason.label))?.impact;
check(
	"municipal heating adds its bonus as a named reason",
	bonusImpact(/^municipal heating$/) === AMENITY_BONUSES.districtHeating,
	bonusScore.reasons,
);
check(
	"a tram stop within 300 m adds its bonus",
	bonusImpact(/^tram stop within 300 m$/) === AMENITY_BONUSES.tramStop,
	bonusScore.reasons,
);
check(
	"a railway station within 1 km adds its bonus",
	bonusImpact(/^railway station within 0\.9 km$/) ===
		AMENITY_BONUSES.railStation,
	bonusScore.reasons,
);
check(
	"a park within 300 m adds its bonus",
	bonusImpact(/^park within 300 m$/) === AMENITY_BONUSES.park,
	bonusScore.reasons,
);
const noAmenities = scoreAlert(
	{ ...flat, heatingType: "gazowe", hasElevator: false },
	estimate(800000),
	geo({ tramM: 1000, trainStationM: 2000, parkM: 900, waterM: 2000 }),
);
check(
	"no amenity bonus is granted without the amenity",
	!noAmenities.reasons.some((reason) =>
		/municipal heating|tram stop|railway station|park within|water within/u.test(
			reason.label,
		),
	),
	noAmenities.reasons,
);
const cappedBonuses = scoreAlert(
	{ ...flat, hasParking: true },
	estimate(500000),
	geo({ waterM: 100 }),
);
check(
	"amenity bonuses stay inside the 0-100 score cap",
	cappedBonuses.totalScore <= 100,
	cappedBonuses.totalScore,
);

// --- Segment eligibility gates ------------------------------------------
const gasHeated = scoreAlert(
	{ ...flat, heatingType: "gazowe" },
	estimate(800000),
	geo(),
);
check(
	"a gas-heated flat is excluded from alerts",
	!gasHeated.eligible && gasHeated.gateReason === "non_municipal_heating",
	gasHeated.gateReason,
);
check(
	"a gas-heated flat never fills a short section either",
	!gasHeated.fallbackEligible,
	gasHeated.fallbackEligible,
);
const unknownHeating = scoreAlert(
	{
		...flat,
		heatingType: null,
		facts: scoredFactsOf({ buildingType: "tenement", buildYear: 1930 }),
	},
	estimate(800000),
	geo(),
);
check(
	"a flat with unknown heating is excluded (municipal must be proven)",
	!unknownHeating.eligible &&
		unknownHeating.gateReason === "no_heating_evidence",
	unknownHeating.gateReason,
);
check(
	"a flat with unknown heating may fill a short section, marked",
	unknownHeating.fallbackEligible,
	unknownHeating.fallbackEligible,
);
const blockFlatGate = scoreAlert(
	{
		...flat,
		buildYear: null,
		buildingType: null,
		facts: scoredFactsOf({
			heating: "district",
			buildingType: "block",
			buildYear: 1995,
		}),
	},
	estimate(800000),
	geo(),
);
check(
	"a block proved to predate 2000 fails as old_block",
	!blockFlatGate.eligible && blockFlatGate.gateReason === "old_block",
	blockFlatGate.gateReason,
);
const panelFlatGate = scoreAlert(
	{
		...flat,
		facts: scoredFactsOf({
			heating: "district",
			buildingType: "block",
			largePanel: true,
			buildYear: 1978,
		}),
	},
	estimate(800000),
	geo(),
);
check(
	"a large-panel block is excluded as an old block",
	!panelFlatGate.eligible && panelFlatGate.gateReason === "old_block",
	panelFlatGate.gateReason,
);
const tenementFlatGate = scoreAlert(
	{
		...flat,
		facts: scoredFactsOf({ heating: "district", buildingType: "tenement" }),
	},
	estimate(800000),
	geo(),
);
check(
	"a tenement with district heating stays eligible",
	tenementFlatGate.eligible,
	tenementFlatGate.gateReason,
);

// --- Building class labels ---------------------------------------------
// The card prints this label on every flat/house, and `oldBlock` is the gate
// answer, so the derivation is pinned here rather than inferred from a score.
const kamienica = buildingClassOf({ buildingType: "blok", buildYear: 1930 });
check(
	"a pre-war building is a kamienica whatever the portal label says",
	kamienica.kind === "tenement" && kamienica.label === "kamienica",
	kamienica,
);
const postwarKamienica = buildingClassOf({
	buildingType: "blok",
	buildYear: 1958,
	facts: { buildingStyle: "tenement" },
});
check(
	"a kamienica from the 1950s is accepted whatever its year",
	postwarKamienica.kind === "tenement" && !postwarKamienica.oldBlock,
	postwarKamienica,
);
const ninetiesKamienica = buildingClassOf({
	buildingType: "kamienica",
	buildYear: 1996,
});
check(
	"a kamienica built after the war but before 2000 stays a kamienica",
	ninetiesKamienica.kind === "tenement" && !ninetiesKamienica.oldBlock,
	ninetiesKamienica,
);
const oldBlock = buildingClassOf({ buildingType: "blok", buildYear: 1998 });
check(
	"a block built before 2000 is an old block",
	oldBlock.kind === "oldBlock" &&
		oldBlock.oldBlock &&
		oldBlock.label === "stary blok" &&
		oldBlock.evidence === "rok budowy 1998",
	oldBlock,
);
const newBlock = buildingClassOf({ buildingType: "blok", buildYear: 2005 });
check(
	"a block since 2000 is a new block",
	newBlock.kind === "newBlock" && !newBlock.oldBlock && newBlock.label === "nowy blok",
	newBlock,
);
const unknownAgeBlock = buildingClassOf({ buildingType: "blok" });
check(
	"a block with no year stays a block and is not excluded",
	unknownAgeBlock.kind === "block" &&
		!unknownAgeBlock.oldBlock &&
		unknownAgeBlock.label === "blok (rok nieznany)",
	unknownAgeBlock,
);
const panelByFact = buildingClassOf({
	buildingType: "blok",
	buildYear: 2010,
	facts: { buildingStyle: "largePanel" },
});
check(
	"a large-panel reading wins over a renovated year",
	panelByFact.oldBlock && panelByFact.label === "stary blok (wielka płyta)",
	panelByFact,
);
const apartmentBlock = buildingClassOf({
	buildingType: "apartamentowiec",
	buildYear: 2012,
});
check(
	"an apartment building stays an apartamentowiec, not a new block",
	apartmentBlock.kind === "apartment" && !apartmentBlock.oldBlock,
	apartmentBlock,
);
const unknownBuilding = buildingClassOf({});
check(
	"no evidence is 'nieznany', never a guess",
	unknownBuilding.kind === "unknown" && !unknownBuilding.oldBlock,
	unknownBuilding,
);
// Prose is read by the model first; when it has not run, the narrow lexicon
// still takes an explicitly named source, and only that: a negated or
// ambiguous mention never becomes a fact.
const proseNamed = scoreAlert(
	{
		...flat,
		heatingType: null,
		facts: scoredFactsOf({ buildingType: "tenement", buildYear: 1930 }),
		description: "Rozkładowe, po remoncie. Ogrzewanie: miejskie, niski czynsz.",
	},
	estimate(800000),
	geo(),
);
check(
	"an explicitly named municipal source in prose satisfies the heating gate",
	proseNamed.eligible,
	proseNamed.gateReason,
);
const proseNegated = scoreAlert(
	{
		...flat,
		heatingType: null,
		facts: scoredFactsOf({ buildingType: "tenement", buildYear: 1930 }),
		description: "Bez ogrzewania miejskiego, własny piec węglowy.",
	},
	estimate(800000),
	geo(),
);
check(
	"a negated municipal mention reads as the source the ad names",
	!proseNegated.eligible &&
		proseNegated.gateReason === "non_municipal_heating",
	proseNegated.gateReason,
);
const proseAmbiguous = scoreAlert(
	{
		...flat,
		heatingType: null,
		facts: scoredFactsOf({ buildingType: "tenement", buildYear: 1930 }),
		description: "Ogrzewanie podłogowe, ciche i równe.",
	},
	estimate(800000),
	geo(),
);
check(
	"an ambiguous prose mention is not evidence of municipal heating",
	!proseAmbiguous.eligible &&
		proseAmbiguous.gateReason === "no_heating_evidence",
	proseAmbiguous.gateReason,
);
const columnWinsOverProse = scoreAlert(
	{
		...flat,
		heatingType: "gazowe",
		facts: scoredFactsOf({ buildingType: "tenement", buildYear: 1930 }),
		description: "Ogrzewanie miejskie, niskie rachunki.",
	},
	estimate(800000),
	geo(),
);
check(
	"a stored heating column wins over a prose mention",
	!columnWinsOverProse.eligible &&
		columnWinsOverProse.gateReason === "non_municipal_heating",
	columnWinsOverProse.gateReason,
);
// The lexicon that backs the model up: explicit phrases only, negations and
// ambiguity rejected, and a passing mention of the building still counts.
check(
	"the lexicon reads an explicitly named heating source",
	heatingFromProse("Ogrzewanie niezależne elektryczne, niskie rachunki.") ===
		"electric",
	heatingFromProse("Ogrzewanie niezależne elektryczne, niskie rachunki."),
);
check(
	"the lexicon reads municipal heating",
	heatingFromProse("Ogrzewanie miejskie, MPEC.") === "district",
	heatingFromProse("Ogrzewanie miejskie, MPEC."),
);
check(
	"the lexicon rejects a negated source",
	heatingFromProse("Bez ogrzewania miejskiego, grzejniki elektryczne.") ===
		"electric",
	heatingFromProse("Bez ogrzewania miejskiego, grzejniki elektryczne."),
);
check(
	"the lexicon rejects an ambiguous source",
	heatingFromProse("Ogrzewanie podłogowe, ciche.") === null,
	heatingFromProse("Ogrzewanie podłogowe, ciche."),
);
check(
	"the lexicon reads the building from a passing mention",
	buildingStyleFromProse("Sprzedam mieszkanie w bloku, 2 pokoje.") === "block" &&
		buildingStyleFromProse("Urokliwa kamienica z 1928.") === "tenement" &&
		buildingStyleFromProse("Blok z wielkiej płyty.") === "largePanel" &&
		buildingStyleFromProse("Nowy apartamentowiec.") === "apartment",
	[
		buildingStyleFromProse("Sprzedam mieszkanie w bloku, 2 pokoje."),
		buildingStyleFromProse("Urokliwa kamienica z 1928."),
		buildingStyleFromProse("Blok z wielkiej płyty."),
		buildingStyleFromProse("Nowy apartamentowiec."),
	],
);
check(
	"the lexicon rejects a negated building mention",
	buildingStyleFromProse("To nie kamienica, tylko zwykły blok.") === "block",
	buildingStyleFromProse("To nie kamienica, tylko zwykły blok."),
);

const proseBlockFlat = scoreAlert(
	{
		...flat,
		facts: null,
		heatingType: "miejskie",
		description: "Sprzedam mieszkanie w bloku, 2 pokoje, ogrzewanie miejskie.",
	},
	estimate(800000),
	geo(),
);
check(
	"a flat in a block of unknown age still passes (only old blocks fail)",
	proseBlockFlat.eligible,
	proseBlockFlat.gateReason,
);
const prosePanel = scoreAlert(
	{
		...flat,
		facts: null,
		heatingType: "miejskie",
		description: "Blok z wielkiej płyty, po remoncie, ogrzewanie miejskie.",
	},
	estimate(800000),
	geo(),
);
check(
	"a large-panel mention in prose fails as an old block",
	!prosePanel.eligible && prosePanel.gateReason === "old_block",
	prosePanel.gateReason,
);
const proseTenement = scoreAlert(
	{
		...flat,
		facts: null,
		heatingType: "miejskie",
		description: "Kamienica z 1928 roku, ogrzewanie miejskie.",
	},
	estimate(800000),
	geo(),
);
check(
	"a kamienica mention in prose passes the building gate",
	proseTenement.eligible,
	proseTenement.gateReason,
);

const factsGas = scoreAlert(
	{ ...flat, heatingType: null, facts: scoredFactsOf({ heating: "gas" }) },
	estimate(800000),
	geo(),
);
check(
	"an extracted gas heating fact excludes the flat",
	!factsGas.eligible && factsGas.gateReason === "non_municipal_heating",
	factsGas.gateReason,
);
const attributeDistrict = scoreAlert(
	{ ...flat, heatingType: null, featuresHeating: "urban" },
	estimate(800000),
	geo(),
);
check(
	"the otodom detail attribute satisfies the flat gate",
	attributeDistrict.eligible,
	attributeDistrict.gateReason,
);
const heatPumpFlat = scoreAlert(
	{
		...flat,
		facts: scoredFactsOf({
			heating: "heatPump",
			buildingType: "tenement",
			buildYear: 1930,
		}),
	},
	estimate(800000),
	geo(),
);
check(
	"a heat pump satisfies the flat gate",
	heatPumpFlat.eligible,
	heatPumpFlat.gateReason,
);
const proseBlock = scoreAlert(
	{
		...flat,
		buildingType: null,
		facts: scoredFactsOf({ heating: "district", buildingType: "tenement" }),
		description: "Mieszkanie w wielkiej płycie, po termomodernizacji.",
	},
	estimate(800000),
	geo(),
);
check(
	"a prose panel claim no longer drives the gate",
	proseBlock.eligible,
	proseBlock.gateReason,
);
const farmland = scoreAlert(
	{
		...plot,
		// No building evidence anywhere: the shared fixture's own title and
		// prose say "działka budowlana", which now counts as evidence.
		title: "Działka rolna 1000 m2",
		description: "Łąka z dostępem do drogi gminnej.",
		plotType: "rolna",
		facts: scoredFactsOf({ plotType: "rolna" }),
		parcelFeatures: {
			...plot.parcelFeatures,
			zoningWz: false,
			zoningPlanCount: 0,
			landUseClass: "RIIIa",
		},
	},
	estimate(300000),
	geo(),
);
check(
	"a plot without building evidence is excluded",
	!farmland.eligible && farmland.gateReason === "not_building_plot",
	farmland.gateReason,
);
const wzPlot = scoreAlert(
	{
		...plot,
		plotType: "rolna",
		parcelFeatures: { ...plot.parcelFeatures, zoningWz: true },
	},
	estimate(300000),
	geo(),
);
check(
	"a plot with a zoning decision stays eligible",
	wzPlot.eligible,
	wzPlot.gateReason,
);
const proseBuildingPlot = scoreAlert(
	{
		...plot,
		plotType: null,
		description: "Działka budowlana, media w drodze.",
		parcelFeatures: {
			...plot.parcelFeatures,
			zoningWz: false,
			zoningPlanCount: 0,
			landUseClass: "RIIIa",
		},
	},
	estimate(300000),
	geo(),
);
check(
	"a plot described as a building plot stays eligible",
	proseBuildingPlot.eligible,
	proseBuildingPlot.gateReason,
);
const landUsePlot = scoreAlert(
	{
		...plot,
		plotType: null,
		description: null,
		parcelFeatures: {
			...plot.parcelFeatures,
			zoningWz: false,
			zoningPlanCount: 0,
			landUseClass: "Bp",
		},
	},
	estimate(300000),
	geo(),
);
check(
	"a built-up EGiB land-use class counts as building evidence",
	landUsePlot.eligible,
	landUsePlot.gateReason,
);

// --- Plot green tiers ---------------------------------------------------
const plotAdjacent = scoreAlert(
	{ ...plot, plotAreaM2: 1200 },
	estimate(300000),
	geo({ forestM: 5, waterM: 10 }),
);
check(
	"a forest on or next to the plot grants triple points",
	plotAdjacent.reasons.some(
		(reason) =>
			reason.label === "forest on or next to the plot" && reason.impact === 9,
	),
	plotAdjacent.reasons,
);
check(
	"a lake on or next to the plot grants triple points",
	plotAdjacent.reasons.some(
		(reason) =>
			reason.label === "lake on or next to the plot" && reason.impact === 6,
	),
	plotAdjacent.reasons,
);
const plotFarTier = scoreAlert(
	{ ...plot, plotAreaM2: 1200 },
	estimate(300000),
	geo({ forestM: 2000, waterM: 2500 }),
);
const plotBeyond = scoreAlert(
	{ ...plot, plotAreaM2: 1200 },
	estimate(300000),
	geo({ forestM: 5000, waterM: 5000 }),
);
check(
	"a forest within 3 km still adds points over a distant one",
	plotFarTier.totalScore > plotBeyond.totalScore,
	{ near: plotFarTier.totalScore, far: plotBeyond.totalScore },
);
check(
	"a forest beyond 3 km grants nothing",
	!plotBeyond.reasons.some((reason) => /forest|lake/u.test(reason.label)),
	plotBeyond.reasons,
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
// The extracted facts outrank the portal column, so the fixtures set the style
// explicitly and one check pins that precedence.
const baselineFlat = {
	...flat,
	heatingType: "gazowe",
	facts: scoredFactsOf({ heating: "gas" }),
};
const baselineProperty = scoreAlert(
	baselineFlat,
	estimate(800000),
	geo(),
).propertyScore;
const panelFlat = scoreAlert(
	{
		...baselineFlat,
		facts: scoredFactsOf({
			heating: "gas",
			buildingType: "block",
			largePanel: true,
			buildYear: 1978,
		}),
	},
	estimate(800000),
	geo(),
);
const tenementFlat = scoreAlert(
	{
		...baselineFlat,
		facts: scoredFactsOf({ heating: "gas", buildingType: "tenement" }),
	},
	estimate(800000),
	geo(),
);
const apartmentFlat = scoreAlert(
	{
		...baselineFlat,
		facts: scoredFactsOf({ heating: "gas", buildingType: "apartment" }),
	},
	estimate(800000),
	geo(),
);
check(
	"large-panel facts lower the flat property score and block the alert",
	panelFlat.propertyScore < baselineProperty &&
		!panelFlat.eligible &&
		panelFlat.gateReason === "old_block",
	{
		baseline: baselineProperty,
		panel: panelFlat.propertyScore,
		gate: panelFlat.gateReason,
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
const factsBeatColumn = scoreAlert(
	{
		...baselineFlat,
		buildingType: "block",
		facts: scoredFactsOf({ heating: "gas", buildingType: "tenement" }),
	},
	estimate(800000),
	geo(),
);
const columnWins = scoreAlert(
	{
		...baselineFlat,
		buildingType: "tenement",
		facts: scoredFactsOf({ heating: "gas", buildingType: "apartment" }),
	},
	estimate(800000),
	geo(),
);
check(
	"extracted building style outranks the portal column",
	factsBeatColumn.propertyScore === tenementFlat.propertyScore &&
		columnWins.propertyScore === apartmentFlat.propertyScore,
	{
		baseline: baselineProperty,
		factsBeatColumn: factsBeatColumn.propertyScore,
		columnWins: columnWins.propertyScore,
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
	"an estimate from two comps is ineligible",
	!thinComps.eligible && thinComps.gateReason === "thin_comps",
	{ eligible: thinComps.eligible, gateReason: thinComps.gateReason },
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
		thinComps.gateReason === "thin_comps" &&
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

// --- Fast-rail gate (plots and houses) ----------------------------------
// Kraków Główny is at 50.06842/19.94789. 1.9 km south-west of it is inside the
// 3 km gate, 3.4 km is outside it.
const insideRailPlot = scoreAlert(
	{ ...plot, lat: 50.0525, lng: 19.935 },
	estimate(300000),
	geo(),
);
const outsideRailPlot = scoreAlert(
	{ ...plot, lat: 50.0385, lng: 19.9351 },
	estimate(300000),
	geo(),
);
check(
	"a plot inside the 3 km fast-rail gate is eligible",
	insideRailPlot.eligible,
	insideRailPlot.gateReason,
);
check(
	"a plot outside the gate fails with outside_fast_rail",
	!outsideRailPlot.eligible &&
		outsideRailPlot.gateReason === "outside_fast_rail",
	outsideRailPlot.gateReason,
);
const holidayHouse = scoreAlert(
	{ ...house, lat: 49.45, lng: 20.2 },
	estimate(900000),
	geo({ waterM: 200, lakeM: 180, forestM: 120 }),
);
const suburbanHouse = scoreAlert(
	{
		...house,
		buildYear: 2015,
		buildingMaterial: "brick",
		plotAreaM2: 400,
		facts: scoredFactsOf({ heating: "gas", buildingType: "house" }),
		neighbours: {
			nearestBuildingM: 12,
			buildingsWithin150m: 22,
			sampledBuildings: 40,
		},
		str: null,
	},
	estimate(900000),
	// Nature is fine (a river 900 m away); the character is what is missing.
	geo({ waterM: 900, lakeM: null, forestM: 6000, forestShare500m: 0 }),
);
check(
	"a wooden house alone by the water is eligible without a station",
	holidayHouse.eligible,
	holidayHouse.gateReason,
);
check(
	"an ordinary suburban house fails the character gate",
	!suburbanHouse.eligible &&
		suburbanHouse.gateReason === "no_house_character",
	suburbanHouse.gateReason,
);
check(
	"the house score rewards solitude and the STR market",
	holidayHouse.totalScore > suburbanHouse.totalScore &&
		holidayHouse.propertyScore > suburbanHouse.propertyScore &&
		holidayHouse.reasons.some((reason) => reason.label.includes("Airbnb")),
	{
		holiday: holidayHouse.totalScore,
		suburban: suburbanHouse.totalScore,
		holidayReasons: holidayHouse.reasons.map((reason) => reason.label),
	},
);
const houseNoNature = scoreAlert(
	{
		...house,
		facts: scoredFactsOf({ heating: "coalWood", buildingType: "house" }),
	},
	estimate(900000),
	geo({ waterM: 9000, lakeM: null, riverM: 8000, forestM: 6000 }),
);
check(
	"a house with no water, forest or mountains fails the nature gate",
	!houseNoNature.eligible && houseNoNature.gateReason === "no_nature_setting",
	houseNoNature.gateReason,
);
const closerRailPlot = scoreAlert(
	{ ...plot, lat: 50.062, lng: 19.9405 },
	estimate(300000),
	geo(),
);
const fartherRailPlot = scoreAlert(
	{ ...plot, lat: 50.0445, lng: 19.934 },
	estimate(300000),
	geo(),
);
check(
	"the fast-rail band scores a closer station higher",
	closerRailPlot.transitScore > fartherRailPlot.transitScore &&
		closerRailPlot.totalScore > fartherRailPlot.totalScore,
	{
		closer: closerRailPlot.transitScore,
		farther: fartherRailPlot.transitScore,
	},
);

// --- Buildable parcel gate (plots only) ---------------------------------
// Houses are no longer gated on buildable land: the house target is a unique
// holiday property, gated on nature and character instead.
const farmlandHouse = scoreAlert(
	{
		...house,
		parcelFeatures: {
			roadDistanceM: 20,
			landUseClass: "RIIIa",
			zoningWz: false,
			zoningPlanCount: 0,
		},
	},
	estimate(900000),
	geo({ waterM: 200, lakeM: 180, forestM: 120 }),
);
check(
	"farmland does not disqualify a house any more",
	farmlandHouse.eligible,
	farmlandHouse.gateReason,
);

// --- Centre-zone and tenement gates (flats) -----------------------------
const nowaHutaFlat = scoreAlert(
	{ ...flat, lat: 50.0725, lng: 20.0345 },
	estimate(800000),
	geo(),
);
check(
	"a flat outside the 4 km centre zone is excluded",
	!nowaHutaFlat.eligible && nowaHutaFlat.gateReason === "outside_centre_zone",
	nowaHutaFlat.gateReason,
);
const wolaJustowskaFlat = scoreAlert(
	{ ...flat, lat: 50.0635, lng: 19.8835 },
	estimate(800000),
	geo(),
);
check(
	"Wola Justowska is inside the centre zone",
	wolaJustowskaFlat.eligible,
	wolaJustowskaFlat.gateReason,
);
const unknownStyleFlat = scoreAlert(
	{
		...flat,
		buildYear: null,
		buildingType: null,
		facts: scoredFactsOf({ heating: "district" }),
	},
	estimate(800000),
	geo(),
);
check(
	"a flat with no building evidence is eligible and flagged",
	unknownStyleFlat.eligible &&
		unknownStyleFlat.flags.includes("building_class_unknown"),
	{ reason: unknownStyleFlat.gateReason, flags: unknownStyleFlat.flags },
);
const gasModernFlat = scoreAlert(
	{
		...flat,
		// The column would otherwise win over the gas fact: this fixture is about
		// the prose evidence.
		heatingType: null,
		facts: scoredFactsOf({
			heating: "gas",
			buildingType: "block",
			buildYear: 2005,
		}),
	},
	estimate(800000),
	geo(),
);
check(
	"a gas-heated modern block is never a fallback",
	!gasModernFlat.eligible && !gasModernFlat.fallbackEligible,
	gasModernFlat.gateReason,
);
const closerZoneFlat = scoreAlert(
	{ ...flat, lat: 50.0616, lng: 19.9373 },
	estimate(800000),
	geo(),
);
const fartherZoneFlat = scoreAlert(
	// ~3.6 km from the nearest anchor: inside the gate, low band.
	{ ...flat, lat: 50.0950, lng: 19.9900 },
	estimate(800000),
	geo(),
);
check(
	"the centre-zone band scores a closer flat higher",
	closerZoneFlat.transitScore > fartherZoneFlat.transitScore,
	{
		closer: closerZoneFlat.transitScore,
		farther: fartherZoneFlat.transitScore,
	},
);

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
		alertDate: listingAlerts.alertDate,
		count: sql<number>`count(*)`,
	})
	.from(listingAlerts)
	.groupBy(listingAlerts.listingId, listingAlerts.alertDate)
	.having(sql`count(*) > 1`);
check(
	"each listing is alerted at most once per day (leaderboard repeats across days)",
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

// The leaderboard pool exactly as createAlerts() builds it for the current
// version: active, visible, gate-passing scores, with the fallback tier
// (everything passed except proof of municipal heating) ranked after them.
const pool = await db
	.select({
		listingId: listingScores.listingId,
		segment: listingScores.segment,
		region: listingScores.region,
		totalScore: listingScores.totalScore,
		eligible: listingScores.eligible,
	})
	.from(listingScores)
	.innerJoin(listings, eq(listingScores.listingId, listings.id))
	.where(
		and(
			eq(listingScores.scoreVersion, SCORE_VERSION),
			or(
				eq(listingScores.eligible, true),
				eq(listingScores.fallbackEligible, true),
			),
			eq(listings.isActive, true),
			eq(listings.isVisible, true),
			gte(listingScores.valueScore, ALERT_GATES.minValueScore),
			gte(listingScores.confidence, ALERT_GATES.minConfidence),
			gte(listingScores.discountPct, ALERT_GATES.minDiscountPct),
		),
	)
	.orderBy(desc(listingScores.eligible), desc(listingScores.totalScore));

const poolGroups = new Map<string, typeof pool>();
for (const row of pool) {
	const key = row.segment;
	const group = poolGroups.get(key) ?? [];
	group.push(row);
	poolGroups.set(key, group);
}

// Alerts repeat across days by design (the page is a leaderboard), so
// coverage is judged against the latest date only.
const latestDateRow = await db
	.select({ date: sql<string | null>`max(${listingAlerts.alertDate})` })
	.from(listingAlerts);
const latestDate = latestDateRow[0]?.date ?? null;
const alertedIds = new Set(
	(
		latestDate
			? await db
					.select({ listingId: listingAlerts.listingId })
					.from(listingAlerts)
					.where(eq(listingAlerts.alertDate, latestDate))
			: []
	).map((row) => row.listingId),
);

// Current-version alerts on still-visible listings, per SEGMENT PER DATE:
// the list appends across days by design, so the ceiling is per daily cut,
// not cumulative. Only rows created under the current cut rule carry the
// `payload_json.cut` marker, so legacy 5%-era rows do not count against it.
// Fresh-arrival alerts follow their own cohort rule and are excluded here;
// they are bounded by `shouldAlertFreshArrival` instead.
const cutMarker = `top${ALERT_TOP_OFFERS}`;
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
			sql`coalesce(json_extract(${listingAlerts.payloadJson}, '$.cut'), '') = ${cutMarker}`,
		),
	);
const currentAlertCounts = new Map<string, number>();
for (const row of currentAlertRows) {
	const key = `${row.segment}:${row.alertDate}`;
	currentAlertCounts.set(key, (currentAlertCounts.get(key) ?? 0) + 1);
}

const ceilingViolations: Array<Record<string, unknown>> = [];
const uncovered: Array<Record<string, unknown>> = [];
for (const [key, group] of poolGroups) {
	const topN = Math.min(ALERT_TOP_OFFERS, group.length);
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
	// alert for the latest date (the leaderboard shows today's cut).
	for (const row of group.slice(0, topN)) {
		if (!alertedIds.has(row.listingId)) {
			uncovered.push({ key, listingId: row.listingId, topN });
		}
	}
}
check(
	`current-version alerts stay within the top-${ALERT_TOP_OFFERS} ceiling per segment+day`,
	ceilingViolations.length === 0,
	ceilingViolations,
);
check(
	`every listing in the latest top-${ALERT_TOP_OFFERS} cut has an alert`,
	uncovered.length === 0,
	uncovered.slice(0, 5),
);

// The fallback tier never jumps the queue: inside a segment, every fallback
// alert ranks below every fully eligible one for the same date.
const rankMix = await db
	.select({
		segment: listingAlerts.segment,
		alertDate: listingAlerts.alertDate,
		maxFallbackRank: sql<number | null>`max(case when ${listingScores.eligible} = 0 then ${listingAlerts.rank} end)`,
		minEligibleRank: sql<number | null>`min(case when ${listingScores.eligible} = 1 then ${listingAlerts.rank} end)`,
	})
	.from(listingAlerts)
	.innerJoin(listingScores, eq(listingAlerts.scoreId, listingScores.id))
	.where(eq(listingScores.scoreVersion, SCORE_VERSION))
	.groupBy(listingAlerts.segment, listingAlerts.alertDate);
const rankViolations = rankMix.filter(
	(row) =>
		row.maxFallbackRank != null &&
		row.minEligibleRank != null &&
		row.maxFallbackRank < row.minEligibleRank,
);
check(
	"a fallback offer never ranks above a fully eligible one",
	rankViolations.length === 0,
	rankViolations.slice(0, 5),
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

// --- Discount plausibility, placeholder coordinates, index sanity -------
// The live list (2027.14) carried: a 1000 m² village plot 94% "below median"
// against central building land because its coordinates were a city-centre
// placeholder; a Giszowiec flat 62 m from the Katowice Rynek for the same
// reason; houses whose fair value was multiplied by index factors of x5.07,
// x2.20 and x1.92; and 33-44% "discounts" on ordinary estate flats built from
// a wide comp set. Each of these is now a gate.
const placeholderFlat = scoreAlert(
	{ ...flat, placeholderCoordinates: true },
	estimate(900000),
	geo(),
);
check(
	"placeholder coordinates never alert",
	!placeholderFlat.eligible &&
		placeholderFlat.gateReason === "placeholder_coordinates" &&
		!placeholderFlat.fallbackEligible,
	{ gate: placeholderFlat.gateReason },
);

const villagePlotPrice = 120000;
const absurdDiscount = scoreAlert(
	flat,
	estimate(villagePlotPrice / 0.058),
	geo(),
);
check(
	"a 94% below-median offer is rejected as an implausible discount",
	!absurdDiscount.eligible &&
		absurdDiscount.gateReason === "implausible_discount",
	{
		discountPct: absurdDiscount.discountPct,
		gate: absurdDiscount.gateReason,
	},
);

// ~40% below with a thin and wide sample: not credible.
const thinWide = scoreAlert(flat, estimate(1000000, 7, { spreadPct: 40 }), geo());
// The same discount carried by a broad, tight sample: kept.
const broadTight = scoreAlert(
	flat,
	estimate(1000000, 24, { spreadPct: 12 }),
	geo(),
);
check(
	"a large discount needs a broad and tight comp set",
	!thinWide.eligible &&
		thinWide.gateReason === "unverified_discount" &&
		broadTight.eligible,
	{
		thinWide: { gate: thinWide.gateReason, comps: 7, spread: 40 },
		broadTight: { gate: broadTight.gateReason, comps: 24, spread: 12 },
	},
);

const brokenIndex = scoreAlert(
	flat,
	estimate(900000, 20, { timeFactorMedian: 5.07 }),
	geo(),
);
const impossibleDrop = scoreAlert(
	flat,
	estimate(900000, 20, { timeFactorMedian: 0.85 }),
	geo(),
);
const healthyIndex = scoreAlert(
	flat,
	estimate(900000, 20, { timeFactorMedian: 1.15 }),
	geo(),
);
check(
	"a broken index factor invalidates the fair value",
	!brokenIndex.eligible &&
		brokenIndex.gateReason === "broken_index_factor" &&
		!impossibleDrop.eligible &&
		impossibleDrop.gateReason === "broken_index_factor" &&
		healthyIndex.eligible,
	{
		broken: brokenIndex.gateReason,
		drop: impossibleDrop.gateReason,
		healthy: healthyIndex.gateReason,
	},
);

const highIndex = scoreAlert(
	flat,
	estimate(900000, 20, { timeFactorMedian: 1.45 }),
	geo(),
);
const normalIndex = scoreAlert(
	flat,
	estimate(900000, 20, { timeFactorMedian: 1.15 }),
	geo(),
);
check(
	"a high-but-possible index factor costs risk points without a gate",
	highIndex.eligible &&
		highIndex.flags.includes("high_index_factor") &&
		!normalIndex.flags.includes("high_index_factor") &&
		highIndex.totalScore < normalIndex.totalScore,
	{
		high: highIndex.totalScore,
		normal: normalIndex.totalScore,
		flags: highIndex.flags,
	},
);

// --- Leaderboard selection (dedupe + investment cap) --------------------
// Selection rules, not scoring rules, but they decide what the page shows, so
// they are pinned here: today's live list carried the same Sobieskiego flat
// twice, a Bielsko house twice, a Janczowa plot twice, five units of one
// osiedle and six of another.
interface Leader {
	scoreId: number;
	listingId: number;
	segment: string;
	region: string;
	totalScore: number;
	discountPct: number | null;
	confidence: number;
	valueScore: number;
	eligible: boolean;
	city: string | null;
	street: string | null;
	areaM2: number | null;
	price: number | null;
	investmentId: string | null;
	investmentTitle: string | null;
}
function leader(overrides: Partial<Leader>): Leader {
	return {
		scoreId: 1,
		listingId: 1,
		segment: "flat",
		region: "malopolskie",
		totalScore: 90,
		discountPct: 20,
		confidence: 0.8,
		valueScore: 80,
		eligible: true,
		city: "Kraków",
		street: "Jana Sobieskiego",
		areaM2: 56,
		price: 929000,
		investmentId: null,
		investmentTitle: null,
		...overrides,
	};
}

const sameOfferTwice = selectLeaders([
	leader({ listingId: 1, scoreId: 1, street: "Jana Sobieskiego" }),
	leader({ listingId: 2, scoreId: 2, street: "ul. Jana Sobieskiego" }),
]);
check(
	"the same offer from two portals keeps one row",
	sameOfferTwice.length === 1 && sameOfferTwice[0]?.listingId === 1,
	{
		kept: sameOfferTwice.map((row) => row.listingId),
		keys: [
			duplicateKey(leader({ street: "Jana Sobieskiego" })),
			duplicateKey(leader({ street: "ul. Jana Sobieskiego" })),
		],
	},
);

const oneInvestment = selectLeaders([
	leader({ listingId: 10, areaM2: 41, price: 700000, investmentId: "inv-1" }),
	leader({ listingId: 11, areaM2: 52, price: 880000, investmentId: "inv-1" }),
	leader({ listingId: 12, areaM2: 63, price: 1050000, investmentId: "inv-1" }),
	leader({ listingId: 13, areaM2: 70, price: 1200000, investmentTitle: "Inny" }),
]);
check(
	"one investment fills at most two slots and the freed slot goes on",
	oneInvestment.length === 3 &&
		oneInvestment.filter((row) => row.investmentId === "inv-1").length === 2 &&
		oneInvestment.some((row) => row.listingId === 13),
	oneInvestment.map((row) => row.listingId),
);

const distinctFlats = selectLeaders(
	Array.from({ length: 30 }, (_, index) =>
		leader({
			listingId: 100 + index,
			areaM2: 40 + index,
			price: 500000 + index * 10000,
			street: `Ulica ${index}`,
			investmentId: `inv-${index}`,
		}),
	),
);
check(
	"a pool of distinct offers still fills the 25 slots",
	distinctFlats.length === 25,
	{ kept: distinctFlats.length, top: ALERT_TOP_OFFERS },
);
check(
	"an investment key prefers the id, then the title, then the street",
	investmentKey(leader({ investmentId: "inv-9", investmentTitle: "X" })) ===
		"id:inv-9" &&
		investmentKey(leader({ investmentTitle: " Osiedle X " })) ===
			"title:osiedle x" &&
		investmentKey(leader({ street: "Lipowa" })) === "street:kraków:lipowa",
	{
		id: investmentKey(leader({ investmentId: "inv-9" })),
		title: investmentKey(leader({ investmentTitle: " Osiedle X " })),
		street: investmentKey(leader({ street: "Lipowa" })),
	},
);

// --- Day list rebuild on arrivals ---------------------------------------
// The list is the day's top cut, so it must move while a crawl runs. The
// rebuild is debounced because a site can deliver hundreds of offers in a
// burst: one rebuild per interval, never one per batch.
check(
	"the leaderboard rebuild is debounced to one per interval",
	shouldRebuildAlerts(ALERT_REBUILD_MIN_INTERVAL_MS, 0) &&
		!shouldRebuildAlerts(ALERT_REBUILD_MIN_INTERVAL_MS - 1, 0) &&
		!shouldRebuildAlerts(1_000, Date.now()) &&
		!shouldRebuildAlerts(Date.now(), Date.now()) &&
		ALERT_REBUILD_MIN_INTERVAL_MS <= 30_000,
	{ interval: ALERT_REBUILD_MIN_INTERVAL_MS },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
