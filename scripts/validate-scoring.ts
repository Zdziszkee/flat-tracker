/**
 * Validation for the transparent alert score.
 *
 *   node --import tsx scripts/validate-scoring.ts
 *
 * Part 1 checks monotonicity and gates on pure fixtures.
 * Part 2 checks the stored scores and alerts in the database.
 */

import { eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingAlerts, listingScores } from "#/db/schema";
import {
	scoreAlert,
	type ScoreListingInput,
} from "#/lib/scoring/alert-score";
import {
	ALERT_GATES,
	SCORE_VERSION,
	SEGMENT_WEIGHTS,
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
		parkCount500m: 1,
		forestM: 600,
		forestShare500m: 0,
		waterM: 1000,
		waterShare1000m: 0,
		lakeM: 1000,
		riverM: 1200,
		railM: 900,
		trainStationM: 900,
		transitM: 300,
		tramM: 300,
		busM: 200,
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

// --- Transit monotonicity ----------------------------------------------
const tram100 = scoreAlert(flat, estimate(800000), geo({ tramM: 100 }));
const tram300 = scoreAlert(flat, estimate(800000), geo({ tramM: 300 }));
const tram900 = scoreAlert(flat, estimate(800000), geo({ tramM: 900 }));
check(
	"closer tram increases transit score",
	tram100.transitScore > tram300.transitScore &&
		tram300.transitScore > tram900.transitScore,
	{
		tram100: tram100.transitScore,
		tram300: tram300.transitScore,
		tram900: tram900.transitScore,
	},
);

const tram100Total = tram100.totalScore;
const tram900Total = tram900.totalScore;
check(
	"closer tram increases total score",
	tram100Total > tram900Total,
	{ tram100Total, tram900Total },
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

// --- Station sweet spot -------------------------------------------------
const stationFar = scoreAlert(flat, estimate(800000), geo({ trainStationM: 900 }));
const stationDoor = scoreAlert(flat, estimate(800000), geo({ trainStationM: 100 }));
check(
	"station at the doorstep is penalized against 900 m",
	stationDoor.transitScore < stationFar.transitScore,
	{
		stationDoor: stationDoor.transitScore,
		stationFar: stationFar.transitScore,
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
	.from(listingScores)
	.where(eq(listingScores.scoreVersion, SCORE_VERSION));
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
check(
	"stored score version matches the current one",
	(stored?.count ?? 0) > 0,
	stored,
);

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

check("scoring tables are readable", true, { scores: stored?.count ?? 0, alerts: alertStats?.count ?? 0 });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
