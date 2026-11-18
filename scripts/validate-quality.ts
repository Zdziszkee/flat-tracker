/**
 * Validate the quality/asking corrections that sit on top of the comparable
 * median: clamp, condition monotonicity, defect/encumbrance caps, the
 * asking-ratio conversion (listings only), the statistics used by the detail
 * card, and upside neutrality when the correction is unknown.
 *
 * Pure, no DB: `bunx tsx scripts/validate-quality.ts`.
 */
import type { FactsPlot, ScoredFacts } from "../src/lib/llm/fact-access.ts";
import { convertCompPrice } from "../src/lib/valuation/comp-price.ts";
import { estimateStatistics } from "../src/lib/valuation/estimate-statistics.ts";
import type { IndexPoint } from "../src/lib/valuation/price-index.ts";
import {
	QUALITY_CLAMP_PCT,
	qualityAdjustment,
} from "../src/lib/valuation/quality-factor.ts";
import { upsidePotential } from "../src/lib/valuation/upside.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

function facts(overrides: Partial<ScoredFacts> = {}): ScoredFacts {
	return {
		heating: null,
		buildingStyle: null,
		condition: null,
		market: null,
		buildYear: null,
		floor: null,
		floorCount: null,
		technology: null,
		insulation: null,
		floorHeating: null,
		heatPump: null,
		recuperation: null,
		airConditioning: null,
		photovoltaics: null,
		parkingSpots: null,
		plotAreaM2: null,
		gardenM2: null,
		legalStatus: null,
		encumbrances: [],
		defects: [],
		tenanted: null,
		plot: null,
		context: null,
		monthlyCosts: null,
		...overrides,
	};
}

function plotFacts(overrides: Partial<FactsPlot> = {}): FactsPlot {
	return {
		type: null,
		media: {
			power: false,
			water: false,
			gas: false,
			sewer: false,
			internet: false,
		},
		mediaCount: 0,
		roadAccess: null,
		wz: null,
		mpzpPurpose: null,
		mpzpSymbol: null,
		shape: null,
		dimensions: null,
		slope: null,
		...overrides,
	};
}

const AS_OF = 2026;

// --- Clamp ---------------------------------------------------------------

const maxPositive = qualityAdjustment({
	segment: "flat",
	facts: facts({
		condition: "excellent",
		buildYear: 2024,
		insulation: true,
		heatPump: true,
		floorHeating: true,
		recuperation: true,
		airConditioning: true,
		photovoltaics: true,
		parkingSpots: 3,
	}),
	asOfYear: AS_OF,
});
check(
	maxPositive.pct === QUALITY_CLAMP_PCT,
	`positive correction clamps at +${QUALITY_CLAMP_PCT} (${maxPositive.pct})`,
);

const maxNegative = qualityAdjustment({
	segment: "flat",
	facts: facts({
		condition: "toRenovation",
		buildYear: 1950,
		buildingStyle: "largePanel",
		technology: "prefab",
		legalStatus: "perpetual_usufruct",
		encumbrances: ["hipoteka", "służebność", "roszczenie"],
		defects: Array.from({ length: 10 }, (_, i) => `usterka ${i + 1}`),
		tenanted: true,
	}),
	buildingMaterial: "wood",
	hasElevator: false,
	floor: "7",
	asOfYear: AS_OF,
});
check(
	maxNegative.pct === -QUALITY_CLAMP_PCT,
	`negative correction clamps at -${QUALITY_CLAMP_PCT} (${maxNegative.pct})`,
);

// --- No facts ------------------------------------------------------------

const unknown = qualityAdjustment({ segment: "flat", facts: null });
check(
	unknown.pct === 0 && unknown.known === false && unknown.reasons.length === 0,
	"no facts -> neutral 0 and known false",
);
const unknownPlot = qualityAdjustment({ segment: "plot", facts: null });
check(
	unknownPlot.pct === 0 && unknownPlot.known === false,
	"plot with no facts -> neutral 0",
);

// --- Condition deck and monotonicity ------------------------------------

const conditionPct = (
	segment: "flat" | "house",
	condition: NonNullable<ScoredFacts["condition"]>,
): number =>
	qualityAdjustment({
		segment,
		facts: facts({ condition }),
		asOfYear: AS_OF,
	}).pct;

const flatDeck = (["toRenovation", "good", "veryGood", "excellent"] as const).map(
	(condition) => conditionPct("flat", condition),
);
const houseDeck = (["toRenovation", "good", "veryGood", "excellent"] as const).map(
	(condition) => conditionPct("house", condition),
);
check(
	flatDeck.every(
		(value, index) => index === 0 || value > (flatDeck[index - 1] as number),
	),
	`condition strictly monotone for flats (${flatDeck.join(" < ")})`,
);
check(
	houseDeck.every(
		(value, index) => index === 0 || value > (houseDeck[index - 1] as number),
	),
	`condition strictly monotone for houses (${houseDeck.join(" < ")})`,
);
check(
	conditionPct("flat", "toRenovation") <= -10 &&
		conditionPct("flat", "toRenovation") >= -12,
	`"do remontu" sits at -10..-12 (${conditionPct("flat", "toRenovation")})`,
);
check(
	conditionPct("flat", "excellent") >= 8 &&
		conditionPct("flat", "excellent") <= 10,
	`"wysoki standard" sits at +8..+10 (${conditionPct("flat", "excellent")})`,
);

// --- Defect / encumbrance caps ------------------------------------------

const defectOnly = qualityAdjustment({
	segment: "flat",
	facts: facts({ defects: Array.from({ length: 10 }, (_, i) => `wada ${i}`) }),
	asOfYear: AS_OF,
}).pct;
check(defectOnly === -4, `defect penalty caps at -4 (${defectOnly})`);

const encumbranceOnly = qualityAdjustment({
	segment: "flat",
	facts: facts({ encumbrances: Array.from({ length: 10 }, (_, i) => `ciężar ${i}`) }),
	asOfYear: AS_OF,
}).pct;
check(
	encumbranceOnly === -2,
	`encumbrance penalty caps at -2 (${encumbranceOnly})`,
);

const defectsAndEncumbrances = qualityAdjustment({
	segment: "flat",
	facts: facts({
		defects: Array.from({ length: 6 }, (_, i) => `wada ${i}`),
		encumbrances: Array.from({ length: 6 }, (_, i) => `ciężar ${i}`),
	}),
	asOfYear: AS_OF,
}).pct;
check(
	defectsAndEncumbrances === -6,
	`defects + encumbrances capped independently (${defectsAndEncumbrances})`,
);

// --- Named negative facts ------------------------------------------------

check(
	qualityAdjustment({
		segment: "flat",
		facts: facts({ legalStatus: "perpetual_usufruct" }),
		asOfYear: AS_OF,
	}).pct === -3,
	"leasehold ownership -3",
);
check(
	qualityAdjustment({
		segment: "flat",
		facts: facts({ tenanted: true }),
		asOfYear: AS_OF,
	}).pct === -1.5,
	"tenanted flat -1.5",
);
check(
	qualityAdjustment({
		segment: "flat",
		facts: facts({}),
		hasElevator: false,
		floor: "4",
		asOfYear: AS_OF,
	}).pct === -2,
	"no lift on the 4th floor -2",
);
check(
	qualityAdjustment({
		segment: "flat",
		facts: facts({ buildingStyle: "block" }),
		asOfYear: AS_OF,
	}).pct === -2,
	"large-panel building -2",
);

// --- Age curve -----------------------------------------------------------

check(
	qualityAdjustment({
		segment: "flat",
		facts: facts({ buildYear: 2024 }),
		asOfYear: AS_OF,
	}).pct === 4,
	"new flat +4 (age curve)",
);
check(
	qualityAdjustment({
		segment: "house",
		facts: facts({ buildYear: 2024 }),
		asOfYear: AS_OF,
	}).pct === 3,
	"new house +3 (age curve)",
);
check(
	qualityAdjustment({
		segment: "flat",
		facts: facts({ buildYear: 1950 }),
		asOfYear: AS_OF,
	}).pct === -6,
	"pre-war flat -6 (age curve)",
);

// --- Plot deck -----------------------------------------------------------

const plotUtilities = (connected: number) => ({
	power: connected >= 1,
	water: connected >= 2,
	gas: connected >= 3,
	sewer: connected >= 4,
	internet: connected >= 5,
});
const mediaFour = qualityAdjustment({
	segment: "plot",
	facts: facts({
		plot: plotFacts({ media: plotUtilities(4), mediaCount: 4 }),
	}),
});
check(mediaFour.pct === 1, `plot media 4/5 -> +1 (${mediaFour.pct})`);
check(
	mediaFour.reasons.some((reason) => reason.label === "media na działce: 4/5"),
	"plot media reason names the count",
);
const mediaNone = qualityAdjustment({
	segment: "plot",
	facts: facts({
		plot: plotFacts({ media: plotUtilities(0), mediaCount: 0 }),
	}),
});
check(mediaNone.pct === -5, `plot with no media -> -5 (${mediaNone.pct})`);
const noAccess = qualityAdjustment({
	segment: "plot",
	facts: facts({
		plot: plotFacts({
			media: plotUtilities(4),
			mediaCount: 4,
			roadAccess: "none",
		}),
	}),
});
check(
	noAccess.reasons.some(
		(reason) => reason.code === "plot_road_access" && reason.pct === -5,
	),
	"plot without public access -5",
);
check(
	qualityAdjustment({ segment: "plot", facts: facts({}), floodRisk: true }).pct ===
		-4,
	"flood-risk plot -4",
);
check(
	qualityAdjustment({ segment: "plot", facts: facts({}), slopeDeg: 30 }).pct ===
		-3,
	"steep plot -3",
);
check(
	qualityAdjustment({
		segment: "plot",
		facts: facts({}),
		landUseClass: "Ls",
	}).pct === -4,
	"forest land-use class -4",
);
const plotClamped = qualityAdjustment({
	segment: "plot",
	facts: facts({
		plot: plotFacts({
			media: plotUtilities(0),
			mediaCount: 0,
			roadAccess: "none",
			shape: "irregular",
			slope: "steep",
			type: "lesna",
		}),
	}),
	landUseClass: "Ls",
	roadDistanceM: 900,
	slopeDeg: 30,
	floodRisk: true,
});
check(
	plotClamped.pct === -QUALITY_CLAMP_PCT,
	`plot correction clamps at -${QUALITY_CLAMP_PCT} (${plotClamped.pct})`,
);

// --- Asking ratio: listings only ----------------------------------------

const listingComp = convertCompPrice({
	source: "listing",
	pricePerM2: 10000,
	askingRatio: 0.96,
});
check(
	listingComp.adjustedPriceM2 === 9600,
	`listing comp gets the asking ratio (${listingComp.adjustedPriceM2})`,
);
check(
	listingComp.indexSource === "asking_ratio" && listingComp.timeFactor === 1,
	"asking ratio is labelled and is not a time factor",
);
const listingIgnoresTime = convertCompPrice({
	source: "listing",
	pricePerM2: 10000,
	askingRatio: 0.9,
	timeFactor: 2,
});
check(
	listingIgnoresTime.adjustedPriceM2 === 9000,
	"listing comp ignores a passed time factor",
);
const listingNoRatio = convertCompPrice({
	source: "listing",
	pricePerM2: 10000,
	askingRatio: null,
});
check(
	listingNoRatio.adjustedPriceM2 === 10000 && listingNoRatio.indexSource === null,
	"listing comp without a ratio stays at face value",
);
const rcnComp = convertCompPrice({
	source: "rcn",
	pricePerM2: 10000,
	timeFactor: 1.1,
	askingRatio: 0.9,
});
check(
	rcnComp.adjustedPriceM2 === 11000 && rcnComp.indexSource === null,
	"RCN comp gets the time factor and never the asking ratio",
);
check(rcnComp.timeFactor === 1.1, "RCN comp keeps its time factor");

// --- Statistics ----------------------------------------------------------

const nowSeconds = Date.UTC(2026, 10, 18) / 1000;
const year = 365 * 86_400;
const statistics = estimateStatistics(
	[
		{
			source: "rcn",
			date: nowSeconds - year,
			timeFactor: 1.2,
			indexSource: "rcn",
			indexFromPeriod: "2023-Q1",
			indexToPeriod: "2026-Q3",
		},
		{
			source: "rcn",
			date: nowSeconds - 3 * year,
			timeFactor: 1.4,
			indexSource: "rcn",
			indexFromPeriod: "2024-Q2",
			indexToPeriod: "2026-Q1",
		},
		{
			source: "listing",
			date: nowSeconds - year,
			timeFactor: 1,
			indexSource: "asking_ratio",
			indexFromPeriod: null,
			indexToPeriod: null,
		},
	],
	{ ratio: 0.94, source: "measured" },
	nowSeconds,
);
check(
	statistics.timeFactorMedian === 1.3,
	`timeFactorMedian > 0 for indexed comps (${statistics.timeFactorMedian})`,
);
check(
	statistics.indexSpan?.from === "2023-Q1" &&
		statistics.indexSpan?.to === "2026-Q3",
	`index span covers the applied factors (${JSON.stringify(statistics.indexSpan)})`,
);
check(
	statistics.askingRatio === 0.94 &&
		statistics.askingRatioSource === "measured",
	"asking ratio and its source are exposed",
);
check(
	statistics.compAgeMedianYears === 1,
	`compAgeMedianYears is the median age (${statistics.compAgeMedianYears})`,
);

const noListing = estimateStatistics(
	[
		{
			source: "rcn",
			date: nowSeconds - year,
			timeFactor: 1.2,
			indexSource: "rcn",
			indexFromPeriod: "2025-Q1",
			indexToPeriod: "2026-Q3",
		},
	],
	{ ratio: 0.96, source: "fallback" },
	nowSeconds,
);
check(
	noListing.askingRatio === null && noListing.askingRatioSource === null,
	"asking ratio is not reported when no listing comp was used",
);
check(
	estimateStatistics([], null, nowSeconds).timeFactorMedian === null,
	"no indexed comps -> null timeFactorMedian",
);

// --- Upside neutrality when the correction is unknown -------------------

const series: IndexPoint[] = [
	{
		segment: "flat",
		geographyType: "region",
		geographyKey: "malopolskie",
		period: "2025-Q2",
		indexValue: 100,
		medianPriceM2: 10000,
		sampleCount: 100,
		source: "rcn",
	},
	{
		segment: "flat",
		geographyType: "region",
		geographyKey: "malopolskie",
		period: "2026-Q2",
		indexValue: 104,
		medianPriceM2: 10400,
		sampleCount: 100,
		source: "rcn",
	},
];
const baseUpside = upsidePotential({
	fairM2: 10000,
	offerM2: 10000,
	series,
	compSpreadPct: 12,
});
const neutralUpside = upsidePotential({
	fairM2: 10000 * (1 + unknown.pct / 100),
	offerM2: 10000,
	series,
	compSpreadPct: 12,
});
check(
	baseUpside != null &&
		neutralUpside != null &&
		baseUpside.mispricePct === neutralUpside.mispricePct,
	"unknown quality correction leaves upside neutral (misprice unchanged)",
);

// --- Summary -------------------------------------------------------------

if (failures > 0) {
	console.log(`\n${failures} check(s) failed`);
	process.exitCode = 1;
} else {
	console.log("\nAll quality/asking checks passed");
}
