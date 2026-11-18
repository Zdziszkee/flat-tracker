/**
 * Validation for the comparable-selection and fair-price metric policy.
 *
 *   node --import tsx scripts/validate-comp-selection.ts
 *
 * Pure fixtures pin the estimator guards, weights, filters, plot families,
 * index band, discount guard and size adjustment. One end-to-end case opens
 * the database to prove the offer is never its own comparable and that two
 * runs of the model on the same listing return the same fair value.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listings } from "#/db/schema";
import {
	type CompCandidate,
	type CompTarget,
	compWeight,
	DEFAULT_SELECTION,
	DISCOUNT_GUARD,
	estimateCompPrice,
	guardTimeFactor,
	INDEX_FACTOR_BAND,
	implausibleDiscount,
	plotClassFamily,
	plotClassFamilyFromType,
	plotFamiliesMatch,
	PRICE_METRIC,
	selectComparables,
} from "#/lib/valuation/comp-selection";
import {
	fitAreaElasticity,
	sizeAdjustmentFactor,
} from "#/lib/valuation/comp-price";
import { estimateSaleValue } from "#/lib/valuation/offer-model";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		passed++;
		console.log(`PASS  ${label}`);
	} else {
		failed++;
		console.log(`FAIL  ${label}`, detail ?? "");
	}
}

const NOW = Math.floor(Date.parse("2026-06-15T00:00:00Z") / 1000);
const DAY = 86_400;

function target(overrides: Partial<CompTarget> = {}): CompTarget {
	return {
		kind: "flat",
		areaM2: 60,
		rooms: 3,
		market: 2,
		asOfSeconds: NOW,
		...overrides,
	};
}

function comp(overrides: Partial<CompCandidate> = {}): CompCandidate {
	return {
		set: "nearbyRcn",
		date: NOW - 180 * DAY,
		areaM2: 60,
		rooms: 3,
		market: 2,
		distanceM: 400,
		...overrides,
	};
}

/* ---------------------------- estimator ---------------------------- */

const entries = [
	{ value: 10_000, weight: 1, areaM2: 40 },
	{ value: 12_000, weight: 1, areaM2: 60 },
	{ value: 14_000, weight: 1, areaM2: 80 },
];
const metrics = [
	"weighted_median",
	"median",
	"mean",
	"area_weighted_median",
	"trimmed_mean",
	"huber",
] as const;
for (const metric of metrics) {
	const value = estimateCompPrice(entries, metric);
	check(
		`${metric}: three small comps return a finite positive value`,
		value != null && value > 0 && Number.isFinite(value),
		value,
	);
	check(
		`${metric}: single comp returns that comp's price`,
		estimateCompPrice([{ value: 13_337, weight: 1 }], metric) === 13_337,
	);
	check(
		`${metric}: non-finite and zero prices are ignored`,
		estimateCompPrice(
			[
				{ value: 0, weight: 1 },
				{ value: Number.NaN, weight: 1 },
				{ value: Number.POSITIVE_INFINITY, weight: 1 },
				{ value: 9000, weight: 1 },
			],
			metric,
		) === 9000,
	);
	check(
		`${metric}: non-positive weights are ignored`,
		estimateCompPrice(
			[
				{ value: 9000, weight: 0 },
				{ value: 11_000, weight: -1 },
				{ value: 12_000, weight: 1 },
			],
			metric,
		) === 12_000,
	);
	check(
		`${metric}: empty sample is null`,
		estimateCompPrice([], metric) === null,
	);
}

/* HuBER: one outlier must not move the estimate more than the trim allows. */
const clean = Array.from({ length: 20 }, (_, index) => ({
	value: 10_000 + index * 10,
	weight: 1,
}));
const withOutlier = [...clean, { value: 200_000, weight: 1 }];
const huberClean = estimateCompPrice(clean, "huber") as number;
const huberOutlier = estimateCompPrice(withOutlier, "huber") as number;
const meanOutlier = estimateCompPrice(withOutlier, "mean") as number;
check(
	"Huber: one 20x outlier moves the estimate by less than 3%",
	Math.abs(huberOutlier / huberClean - 1) < 0.03,
	{ huberClean, huberOutlier },
);
check(
	"mean: the same outlier moves the mean by more than 30% (why robust matters)",
	meanOutlier / estimateCompPrice(clean, "mean")! - 1 > 0.3,
);
const trimmedOutlier = estimateCompPrice(withOutlier, "trimmed_mean") as number;
const trimmedClean = estimateCompPrice(clean, "trimmed_mean") as number;
check(
	"trimmed mean: one outlier moves the estimate by less than 1%",
	Math.abs(trimmedOutlier / trimmedClean - 1) < 0.01,
	{ trimmedClean, trimmedOutlier },
);
check("chosen metric is the weighted median", PRICE_METRIC === "weighted_median");

/* ------------------------------ weights ---------------------------- */

const near = compWeight(comp({ distanceM: 100 }), target());
const far = compWeight(comp({ distanceM: 1000 }), target());
const farther = compWeight(comp({ distanceM: 3000 }), target());
check("weight decreases with distance", near > far && far > farther, {
	near,
	far,
	farther,
});
const fresh = compWeight(comp({ date: NOW - 30 * DAY }), target());
const stale = compWeight(comp({ date: NOW - 4 * 365 * DAY }), target());
check("weight decreases with age", fresh > stale);
const sameBuilding = compWeight(
	comp({ set: "buildingRcn", distanceM: null }),
	target(),
);
check(
	"same-building comp outweighs an otherwise identical nearby comp",
	sameBuilding > compWeight(comp({ distanceM: 400 }), target()),
);
check(
	"listing weight multiplier is below the sale weight",
	selectComparables(
		target(),
		[
			comp({ set: "listing", distanceM: 300 }),
			comp({ set: "nearbyRcn", distanceM: 300 }),
		],
		{ ...DEFAULT_SELECTION, minComps: 1 },
	).entries[0]?.comp.set === "nearbyRcn",
);

/* ------------------------------ filters ---------------------------- */

const belowBand = selectComparables(target({ areaM2: 100 }), [comp({ areaM2: 80 })], {
	...DEFAULT_SELECTION,
	minComps: 1,
});
const aboveBand = selectComparables(target({ areaM2: 80 }), [comp({ areaM2: 100 })], {
	...DEFAULT_SELECTION,
	minComps: 1,
});
check(
	"area band is symmetric: 0.80 and 1.25 land on the same relaxation level",
	belowBand.level === aboveBand.level && belowBand.level === 1,
	{ below: belowBand.level, above: aboveBand.level },
);
const inBand = selectComparables(target({ areaM2: 100 }), [comp({ areaM2: 110 })], {
	...DEFAULT_SELECTION,
	minComps: 1,
});
check("an area within the strict band uses level 0", inBand.level === 0, inBand.level);

const roomComp = comp({ rooms: 4 });
const roomsSymmetric =
	selectComparables(
		target({ rooms: 5 }),
		[roomComp],
		{ ...DEFAULT_SELECTION, minComps: 1, roomsMode: "filter" },
	).comps.length ===
	selectComparables(
		target({ rooms: 3 }),
		[roomComp],
		{ ...DEFAULT_SELECTION, minComps: 1, roomsMode: "filter" },
	).comps.length;
check("rooms band is symmetric around the target", roomsSymmetric);

const future = comp({ date: NOW + 1 });
check(
	"a comp newer than the target's clock is never used (no lookahead)",
	selectComparables(target(), [future], {
		...DEFAULT_SELECTION,
		minComps: 1,
	}).comps.length === 0,
);
const old = comp({ date: NOW - 6 * 365 * DAY });
check(
	"the five-year window excludes an older comp",
	selectComparables(target(), [old], {
		...DEFAULT_SELECTION,
		minComps: 1,
	}).comps.length === 0,
);
check(
	"the window can be widened explicitly",
	selectComparables(target(), [old], {
		...DEFAULT_SELECTION,
		minComps: 1,
		maxAgeSeconds: Number.POSITIVE_INFINITY,
	}).comps.length === 1,
);

const strict = selectComparables(
	target(),
	[comp({ market: 1 }), comp({ market: 2 }), comp({ market: 2 })],
	{ ...DEFAULT_SELECTION, minComps: 1 },
);
check(
	"market filter drops the proven mismatch on the strict bands",
	strict.comps.every((row) => row.market === 2),
);
check(
	"market unknown-vs-known is treated as a match",
	selectComparables(
		target(),
		[comp({ market: null }), comp({ market: 2 }), comp({ market: 2 })],
		DEFAULT_SELECTION,
	).comps.length === 3,
);

const capSet = selectComparables(
	target(),
	Array.from({ length: 60 }, (_, index) =>
		comp({ distanceM: 100 + index, areaM2: 60 + (index % 5) }),
	),
	{ ...DEFAULT_SELECTION, cap: 40, minComps: 3 },
);
check("the comp cap truncates the set", capSet.comps.length === 40);

/* --------------------------- plot families ------------------------- */

check("EGiB B -> built", plotClassFamily("B") === "built");
check("EGiB Ba -> built", plotClassFamily("Ba") === "built");
check("EGiB RIIIa -> agricultural", plotClassFamily("RIIIa") === "agricultural");
check("EGiB RV,PsV -> agricultural", plotClassFamily("RV,PsV") === "agricultural");
check("EGiB ŁIII -> agricultural", plotClassFamily("ŁIII") === "agricultural");
check("EGiB LsIV -> forest", plotClassFamily("LsIV") === "forest");
check("EGiB W -> water", plotClassFamily("W") === "water");
check("advert 'działka budowlana' -> built", plotClassFamilyFromType("działka budowlana") === "built");
check("advert 'rolna' -> agricultural", plotClassFamilyFromType("działka rolna") === "agricultural");
check("unknown family is null", plotClassFamily(null) === null);
check(
	"plot families must agree on both sides",
	plotFamiliesMatch("built", "built") &&
		!plotFamiliesMatch("built", "agricultural") &&
		!plotFamiliesMatch("built", null),
);
const plotTarget = target({
	kind: "plot",
	areaM2: 1000,
	plotClassFamily: "built",
	rooms: null,
	market: null,
});
const plotCandidates: CompCandidate[] = [
	comp({
		areaM2: 1000,
		distanceM: 300,
		rooms: null,
		market: null,
		plotClassFamily: "built",
	}),
	comp({
		areaM2: 1000,
		distanceM: 300,
		rooms: null,
		market: null,
		plotClassFamily: "agricultural",
	}),
	comp({
		areaM2: 1000,
		distanceM: 300,
		rooms: null,
		market: null,
		plotClassFamily: null,
	}),
];
const agreed = selectComparables(plotTarget, plotCandidates, {
	...DEFAULT_SELECTION,
	minComps: 1,
	requirePlotTypeAgreement: true,
});
check(
	"plot type agreement keeps only the same family",
	agreed.comps.length === 1 && agreed.comps[0]?.plotClassFamily === "built",
	agreed.comps.length,
);
check(
	"plot type agreement counts the dropped mismatches",
	agreed.plotMismatchCount === 2,
	agreed.plotMismatchCount,
);

/* ---------------------------- index guard -------------------------- */

const guard5 = guardTimeFactor({ factor: 5.07, regionFactor: 1.3 });
check(
	"a ×5.07 grid factor against a ×1.30 regional factor is replaced",
	guard5.replaced && Math.abs(guard5.factor - 1.3) < 1e-9,
	guard5,
);
check(
	"a ×1.4 grid factor against ×1.30 is kept",
	!guardTimeFactor({ factor: 1.4, regionFactor: 1.3 }).replaced,
);
check(
	"a ×0.4 grid factor against ×1.30 is replaced (downward artifact)",
	guardTimeFactor({ factor: 0.4, regionFactor: 1.3 }).replaced,
);
check(
	"without a regional factor the narrow factor is kept",
	!guardTimeFactor({ factor: 5, regionFactor: null }).replaced,
);
check("the index band is 1.5", INDEX_FACTOR_BAND === 1.5);

/* --------------------------- discount guard ------------------------ */

const deepTight = implausibleDiscount({
	offerM2: 4000,
	fairM2: 10_000,
	compCount: 20,
	p25M2: 9000,
	p75M2: 11_000,
});
check(
	"a 60% discount on 20 tight comps is plausible",
	!deepTight.implausible,
	deepTight,
);
const deepThin = implausibleDiscount({
	offerM2: 4000,
	fairM2: 10_000,
	compCount: 4,
	p25M2: 9000,
	p75M2: 11_000,
});
check("the same discount on 4 comps is implausible", deepThin.implausible);
const deepWide = implausibleDiscount({
	offerM2: 4000,
	fairM2: 10_000,
	compCount: 20,
	p25M2: 5000,
	p75M2: 18_000,
});
check("the same discount on a wide spread is implausible", deepWide.implausible);
const auction = implausibleDiscount({
	offerM2: 6000,
	fairM2: 10_000,
	compCount: 4,
	p25M2: 9000,
	p75M2: 11_000,
});
check(
	"a 40% discount (court-auction territory) is never flagged",
	!auction.implausible,
	auction,
);
check("the guard threshold is 45%", DISCOUNT_GUARD.discountPct === 45);

/* --------------------------- size adjustment ----------------------- */

check(
	"beta 0 leaves the comp unchanged",
	sizeAdjustmentFactor({ beta: 0, compAreaM2: 90, targetAreaM2: 40 }) === 1,
);
check(
	"a larger comp is scaled up for a small target (small units trade higher)",
	sizeAdjustmentFactor({ beta: 0.15, compAreaM2: 90, targetAreaM2: 40 }) > 1,
);
check(
	"a smaller comp is scaled down for a large target",
	sizeAdjustmentFactor({ beta: 0.15, compAreaM2: 40, targetAreaM2: 90 }) < 1,
);
check(
	"missing area leaves the comp unchanged",
	sizeAdjustmentFactor({ beta: 0.15, compAreaM2: null, targetAreaM2: 40 }) === 1,
);
const monotone =
	sizeAdjustmentFactor({ beta: 0.15, compAreaM2: 100, targetAreaM2: 60 }) >
	sizeAdjustmentFactor({ beta: 0.15, compAreaM2: 40, targetAreaM2: 60 });
check(
	"size adjustment rises with comp area (a bigger comp trades lower per m²)",
	monotone,
);
const fit = fitAreaElasticity(
	Array.from({ length: 200 }, (_, index) => {
		const areaM2 = 30 + index;
		return { areaM2, pricePerM2: 20_000 * areaM2 ** -0.2 };
	}),
);
check(
	"the elasticity fit recovers a known -0.2 slope as beta 0.2",
	fit != null && Math.abs(fit.beta - 0.2) < 0.01,
	fit,
);

/* ---------------------------- determinism -------------------------- */

const candidateSets = Array.from({ length: 25 }, (_, index) =>
	comp({
		distanceM: 100 + index * 60,
		areaM2: 50 + (index % 9),
		date: NOW - (index + 1) * 40 * DAY,
	}),
);
const runOnce = () => {
	const selection = selectComparables(target(), candidateSets, DEFAULT_SELECTION);
	return estimateCompPrice(
		selection.entries.map((entry) => ({
			value: 10_000 + entry.comp.areaM2 * 30,
			weight: entry.weight,
			areaM2: entry.comp.areaM2,
		})),
		PRICE_METRIC,
	);
};
check("the same fixture returns the same estimate twice", runOnce() === runOnce());

/* -------------------------- end-to-end (DB) ------------------------ */

async function endToEnd(): Promise<void> {
	const rows = await db
		.select({
			id: listings.id,
			source: listings.source,
			externalId: listings.externalId,
			title: listings.title,
			price: listings.price,
			pricePerM2: listings.pricePerM2,
			areaM2: listings.areaM2,
			rooms: listings.rooms,
			district: listings.district,
			lat: listings.lat,
			lng: listings.lng,
			buildingId: listings.buildingId,
			market: listings.market,
			plotType: listings.plotType,
		})
		.from(listings)
		.where(
			and(
				eq(listings.offerType, "sale"),
				eq(listings.propertyType, "apartment"),
				isNotNull(listings.pricePerM2),
				isNotNull(listings.areaM2),
				isNotNull(listings.lat),
				sql`${listings.pricePerM2} between 3000 and 30000`,
			),
		)
		.limit(20);
	if (rows.length === 0) {
		console.log("SKIP  end-to-end: no suitable listing in this database");
		return;
	}
	let row = rows[0]!;
	let offer = {
		id: row.id,
		source: row.source,
		externalId: row.externalId,
		title: row.title,
		price: row.price,
		pricePerM2: row.pricePerM2,
		areaM2: row.areaM2,
		rooms: row.rooms,
		district: row.district,
		lat: row.lat,
		lng: row.lng,
		buildingId: row.buildingId,
		market: row.market,
		plotType: row.plotType,
		kind: "flat" as const,
	};
	let first = await estimateSaleValue(offer);
	for (const candidate of rows.slice(1)) {
		if (first.estimate != null) break;
		row = candidate;
		offer = {
			id: row.id,
			source: row.source,
			externalId: row.externalId,
			title: row.title,
			price: row.price,
			pricePerM2: row.pricePerM2,
			areaM2: row.areaM2,
			rooms: row.rooms,
			district: row.district,
			lat: row.lat,
			lng: row.lng,
			buildingId: row.buildingId,
			market: row.market,
			plotType: row.plotType,
			kind: "flat" as const,
		};
		first = await estimateSaleValue(offer);
	}
	const second = await estimateSaleValue(offer);
	check(
		"end-to-end: the model produces an estimate on a live listing",
		first.estimate != null,
		first.reason,
	);
	if (!first.estimate) return;
	check(
		"end-to-end: the offer is never its own comparable",
		!first.estimate.comparables.some(
			(comp) =>
				comp.id === `listing:${row.source}:${row.externalId}` ||
				comp.id === String(row.id),
		),
		first.estimate.comparables.map((comp) => comp.id),
	);
	check(
		"end-to-end: two runs produce the same fair zł/m²",
		first.estimate.fairM2 === second.estimate?.fairM2,
		{ first: first.estimate.fairM2, second: second.estimate?.fairM2 },
	);
	check(
		"end-to-end: the estimate records the chosen metric",
		first.estimate.metric === PRICE_METRIC,
		first.estimate.metric,
	);
}

await endToEnd();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
