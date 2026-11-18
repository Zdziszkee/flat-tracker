/**
 * Validation for model-extracted listing facts (pure, no network; the only
 * DB touch is a `loadScoredFacts([])` call that returns before it queries).
 *
 *   bun run validate:facts
 *
 * The model is a data source, not a trusted one, so the parsing and
 * normalization rules are pinned here: enum vocabulary, Polish aliases,
 * range checks, unknown ids, code fences, nested v2 objects (utilities,
 * monthly costs, context), code lists, exposure, the `ScoredFacts`
 * projection the scoring layer imports, and the prompt contract.
 *
 * It also pins the once-per-offer contract: an offer reaches the model at most
 * once per (text, prompt version), an answer with no facts is stored as
 * processed, a failed batch is not stored at all, and no scoring/alerting/
 * valuation consumer calls the model or reads a fact the prompt does not ask
 * for.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import {
	DESCRIPTION_LIMIT,
	EXPOSURE_TOKENS,
	FACT_BATCH_CHAR_BUDGET,
	FACT_BATCH_SIZE,
	FACT_PROMPT_VERSION,
	FACT_VALUES,
	asExposure,
	extractJsonObject,
	factBatches,
	factPrompt,
	factPromptCost,
	factRowOutcomes,
	factTextHash,
	isEmptyFacts,
	normalizeFacts,
	parseFactsAnswer,
	parseFactsResponse,
	promptDescription,
	selectFactCandidates,
} from "#/lib/llm/listing-facts.ts";
import {
	FACTS_CONTEXT_KEYS,
	FACTS_MONTHLY_COST_KEYS,
	FACTS_PLOT_KEYS,
	SCORED_FACTS_KEYS,
	SCORED_FACT_SOURCES,
	loadScoredFacts,
	scoredFactsOf,
} from "#/lib/llm/fact-access.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		passed += 1;
		console.log(`ok   ${name}`);
		return;
	}
	failed += 1;
	console.log(`FAIL ${name}`);
	if (detail !== undefined) {
		console.log(`     ${JSON.stringify(detail)}`);
	}
}

const ids = [101, 102, 103];

// --- Prompt contract ----------------------------------------------------
const prompt = factPrompt([
	{ id: 101, title: "Mieszkanie 60 m2", description: "Ogrzewanie miejskie." },
]);
const system = prompt[0]?.content ?? "";
const user = prompt[1]?.content ?? "";
check(
	"the prompt version is 4",
	FACT_PROMPT_VERSION === "4",
	FACT_PROMPT_VERSION,
);
for (const [field, values] of Object.entries(FACT_VALUES)) {
	check(
		`the system prompt lists every ${field} token`,
		values.every((value) => system.includes(value)),
		values,
	);
}
check(
	"the system prompt lists every exposure token",
	EXPOSURE_TOKENS.every((token) => system.includes(`"${token}"`)),
	EXPOSURE_TOKENS,
);
check(
	"the system prompt describes the v2 nested objects",
	["utilities", "monthlyCosts", "context", "defects", "encumbrances"].every(
		(key) => system.includes(key),
	),
);
const schemaKeys = [
	"heating",
	"buildingType",
	"largePanel",
	"plotType",
	"buildingMaterial",
	"condition",
	"ownership",
	"market",
	"buildYear",
	"plotAreaM2",
	"floor",
	"floorCount",
	"hasBalcony",
	"hasTerrace",
	"hasGarden",
	"hasElevator",
	"hasParking",
	"hasGarage",
	"hasBasement",
	"utilities",
	"roadAccess",
	"mpzpSymbol",
	"mpzpPurpose",
	"buildingPermitWz",
	"plotShape",
	"plotDimensions",
	"plotSlope",
	"fencing",
	"kitchen",
	"exposure",
	"windows",
	"technology",
	"insulation",
	"floorHeating",
	"heatPump",
	"recuperation",
	"airConditioning",
	"photovoltaics",
	"parkingSpots",
	"balconyM2",
	"terraceM2",
	"gardenM2",
	"garageM2",
	"legalStatus",
	"encumbrances",
	"defects",
	"context",
	"tenanted",
	"urgency",
	"monthlyCosts",
];
check(
	"the answer schema names every fact key",
	schemaKeys.every((key) => system.includes(`"${key}":`)),
	schemaKeys.filter((key) => !system.includes(`"${key}":`)),
);
check(
	"the system prompt asks for JSON only, no prose",
	/tylko|wyłącznie/iu.test(system) &&
		/bez prozy/iu.test(system) &&
		/json/iu.test(system),
);
check(
	"the system prompt forbids guessing and defaults to null/false",
	/nie zgaduj/iu.test(system) && /\bfalse\b/u.test(system) && /null/u.test(system),
);
check(
	"the user prompt carries the id and the title",
	user.includes("[101]") && user.includes("Mieszkanie 60 m2"),
	user.slice(0, 120),
);

// --- Response parsing ---------------------------------------------------
const fenced = `\`\`\`json
{"results":[{"id":101,"heating":"district","buildingType":"tenement"}]}
\`\`\``;
check(
	"a fenced JSON answer is parsed",
	parseFactsResponse(fenced, ids).get(101)?.heating === "district",
);
const prose =
	'Oto wynik: {"results":[{"id":101,"heating":"gazowe"}]} — mam nadzieję, że pasuje.';
check(
	"JSON surrounded by prose is parsed",
	parseFactsResponse(prose, ids).get(101)?.heating === "gas",
	parseFactsResponse(prose, ids).get(101),
);
check(
	"a bare array answer is parsed",
	parseFactsResponse('[{"id":102,"heating":"district"}]', ids).get(102)
		?.heating === "district",
);
check(
	"an answer for a listing that was not requested is dropped",
	!parseFactsResponse('{"results":[{"id":999,"heating":"district"}]}', ids).has(
		999,
	),
);
check(
	"an unparseable answer yields no facts",
	parseFactsResponse("no json here", ids).size === 0,
);
check(
	"extractJsonObject rejects text without an object",
	extractJsonObject("nic tu nie ma") === null,
);
const missingRow = parseFactsResponse('{"results":[{"id":101}]}', ids);
check(
	"a row with every fact unknown is still a row",
	missingRow.get(101) != null &&
		isEmptyFacts(missingRow.get(101) ?? ({} as never)),
);

// --- Normalization ------------------------------------------------------
function factsOf(raw: Record<string, unknown>) {
	return normalizeFacts({ id: 1, ...raw });
}
check(
	"unknown means null, not a stored value",
	factsOf({ heating: "unknown" })?.heating === null &&
		factsOf({ windows: "unknown" })?.windows === null &&
		factsOf({ urgency: "unknown" })?.urgency === null,
);
check(
	"v1 vocabularies keep their ids",
	factsOf({ heating: "district" })?.heating === "district" &&
		factsOf({ buildingType: "block" })?.buildingType === "block" &&
		factsOf({ plotType: "budowlana" })?.plotType === "budowlana" &&
		factsOf({ buildingMaterial: "brick" })?.buildingMaterial === "brick" &&
		factsOf({ condition: "to_renovation" })?.condition === "to_renovation" &&
		factsOf({ ownership: "full_ownership" })?.ownership === "full_ownership",
);
check(
	"Polish words are mapped to their tokens",
	factsOf({ heating: "miejskie" })?.heating === "district" &&
		factsOf({ buildingType: "kamienica" })?.buildingType === "tenement" &&
		factsOf({ buildingType: "wielka płyta" })?.buildingType === "block" &&
		factsOf({ plotType: "leśna" })?.plotType === "lesna",
);
check(
	"v2 enums map their Polish aliases",
	factsOf({ roadAccess: "droga prywatna" })?.roadAccess === "private" &&
		factsOf({ mpzpPurpose: "MN/U" })?.mpzpPurpose === "residential_services" &&
		factsOf({ legalStatus: "spółdzielcze własnościowe" })?.legalStatus ===
			"cooperative" &&
		factsOf({ kitchen: "aneks" })?.kitchen === "annex" &&
		factsOf({ windows: "wymienione" })?.windows === "new" &&
		factsOf({ technology: "murowana" })?.technology === "traditional" &&
		factsOf({ urgency: "pilne" })?.urgency === "urgent",
);
check(
	"an unrecognized enum value becomes null",
	factsOf({ condition: "swietny" })?.condition === null &&
		factsOf({ heating: "geotermia" })?.heating === null &&
		factsOf({ roadAccess: "autostrada" })?.roadAccess === null &&
		factsOf({ windows: "pvc" })?.windows === "new",
);
check(
	"enum matching is case and whitespace insensitive",
	factsOf({ heating: "  District " })?.heating === "district" &&
		factsOf({ windows: " NEW " })?.windows === "new",
);
check(
	"booleans parse from JSON booleans and strings",
	factsOf({ hasBalcony: true })?.hasBalcony === true &&
		factsOf({ hasElevator: "false" })?.hasElevator === false &&
		factsOf({ hasGarden: "maybe" })?.hasGarden === null,
);
check(
	"numbers outside a plausible range become null",
	factsOf({ buildYear: 9202 })?.buildYear === null &&
		factsOf({ buildYear: 1998 })?.buildYear === 1998 &&
		factsOf({ floorCount: 0 })?.floorCount === null &&
		factsOf({ plotAreaM2: -5 })?.plotAreaM2 === null,
);
check(
	"a decimal string is accepted as a number",
	factsOf({ floor: "3" })?.floor === 3,
);
check(
	"a non-object row is rejected",
	normalizeFacts([]) === null && normalizeFacts("x") === null,
);

// --- v2 fields ----------------------------------------------------------
const rich = factsOf({
	utilities: {
		power: true,
		water: "false",
		gas: null,
		sewer: true,
		internet: "maybe",
	},
	monthlyCosts: {
		rent: "1 200 zł",
		funduszRemontowy: 300,
		mediaIncluded: "false",
		advance: 250,
		agencyFeePct: "2,5%",
	},
	context: {
		lake: true,
		river: "false",
		forest: "true",
		mountains: null,
		view: "widok na jezioro",
	},
	defects: [
		"4. piętro bez windy",
		"<b>Media do doprowadzenia</b>",
		"4. piętro bez windy",
		"",
		42,
	],
	encumbrances: ["hipoteka", "służebność"],
	roadAccess: "publiczna",
	mpzpSymbol: "MN/U",
	mpzpPurpose: "mieszkaniowa",
	buildingPermitWz: true,
	plotShape: "prostokątna",
	plotDimensions: "20x40 m",
	plotSlope: "płaska",
	fencing: true,
	kitchen: "aneks",
	exposure: ["S", "W"],
	windows: "wymienione",
	technology: "prefabrykowana",
	insulation: true,
	floorHeating: true,
	heatPump: true,
	recuperation: true,
	airConditioning: true,
	photovoltaics: true,
	parkingSpots: "2 miejsca",
	balconyM2: "6",
	terraceM2: 0,
	gardenM2: "120",
	garageM2: 18,
	legalStatus: "spółdzielcze własnościowe",
	tenanted: false,
	urgency: "pilne",
	heating: "miejskie",
	buildingType: "blok",
	plotType: "budowlana",
	condition: "po remoncie",
	buildYear: 2019,
	floor: 3,
	floorCount: 10,
	plotAreaM2: 800,
});
check(
	"utilities parse per utility, unstated means false",
	rich?.utilities?.power === true &&
		rich.utilities.water === false &&
		rich.utilities.gas === false &&
		rich.utilities.sewer === true &&
		rich.utilities.internet === false,
	rich?.utilities,
);
check(
	"utility objects with every value null become null",
	factsOf({ utilities: { power: null, water: null } })?.utilities === null,
);
check(
	"monthly costs parse amounts and the commission",
	rich?.monthlyCosts?.rent === 1200 &&
		rich.monthlyCosts.funduszRemontowy === 300 &&
		rich.monthlyCosts.mediaIncluded === false &&
		rich.monthlyCosts.advance === 250 &&
		rich.monthlyCosts.agencyFeePct === 2.5,
	rich?.monthlyCosts,
);
check(
	"monthly cost ranges reject impossible values",
	factsOf({ monthlyCosts: { rent: 50_000 } })?.monthlyCosts === null &&
		factsOf({ monthlyCosts: { agencyFeePct: 40 } })?.monthlyCosts === null &&
		factsOf({ monthlyCosts: { advance: -1 } })?.monthlyCosts === null,
);
check(
	"context parses the setting flags and the view text",
	rich?.context?.lake === true &&
		rich.context.river === false &&
		rich.context.forest === true &&
		rich.context.mountains === false &&
		rich.context.view === "widok na jezioro",
	rich?.context,
);
check(
	"an empty context becomes null",
	factsOf({ context: { lake: null, view: "" } })?.context === null,
);
check(
	"defects are slugged, sanitized and deduped",
	rich?.defects?.length === 2 &&
		rich.defects[0] === "4_pietro_bez_windy" &&
		rich.defects[1] === "media_do_doprowadzenia",
	rich?.defects,
);
check(
	"encumbrances parse as a code list",
	rich?.encumbrances?.length === 2 &&
		rich.encumbrances[0] === "hipoteka" &&
		rich.encumbrances[1] === "sluzebnosc",
	rich?.encumbrances,
);
const longDefects = factsOf({
	defects: Array.from({ length: 20 }, (_, index) => `wada ${index}`),
});
check(
	"at most eight list entries are kept",
	longDefects?.defects?.length === 8,
	longDefects?.defects,
);
check(
	"a single string list entry is kept whole",
	factsOf({ defects: "brak windy" })?.defects?.[0] === "brak_windy",
);
check(
	"v2 strings are bounded",
	rich?.mpzpSymbol === "MN/U" &&
		rich.plotDimensions === "20x40 m" &&
		(rich.mpzpSymbol?.length ?? 0) <= 24,
);
check(
	"v2 counts and areas parse",
	rich?.parkingSpots === 2 &&
		rich.balconyM2 === 6 &&
		rich.terraceM2 === 0 &&
		rich.gardenM2 === 120 &&
		rich.garageM2 === 18,
);
check(
	"count and area ranges reject impossible values",
	factsOf({ parkingSpots: 400 })?.parkingSpots === null &&
		factsOf({ parkingSpots: 2.6 })?.parkingSpots === 3 &&
		factsOf({ balconyM2: 9000 })?.balconyM2 === null &&
		factsOf({ gardenM2: -3 })?.gardenM2 === null,
);
check(
	"a non-empty nested object counts as facts",
	!isEmptyFacts(rich ?? ({} as never)) &&
		isEmptyFacts(factsOf({}) ?? ({} as never)),
);

// --- Exposure -----------------------------------------------------------
check(
	"exposure keeps a subset of N/S/E/W",
	JSON.stringify(asExposure(["S", "W", "N", "S"])) === '["N","S","W"]',
	asExposure(["S", "W", "N", "S"]),
);
check(
	"exposure accepts Polish compass words in one entry",
	JSON.stringify(asExposure("wschód-zachód")) === '["E","W"]',
	asExposure("wschód-zachód"),
);
check(
	"exposure accepts a single string and compact letters",
	JSON.stringify(asExposure("południowa")) === '["S"]' &&
		JSON.stringify(asExposure("NS")) === '["N","S"]',
);
check(
	"exposure drops unknown tokens",
	asExposure(["up", "down"]) === null &&
		asExposure(null) === null &&
		asExposure("") === null,
);

// --- ScoredFacts projection --------------------------------------------
const scored = scoredFactsOf(rich as unknown as Record<string, unknown>);
check(
	"heating and building style project",
	scored?.heating === "district" && scored.buildingStyle === "largePanel",
	scored,
);
check(
	"condition and build year project",
	scored?.condition === "excellent" &&
		scored.buildYear === 2019 &&
		scored.floor === 3 &&
		scored.floorCount === 10,
	scored,
);
check(
	"quality flags project",
	scored?.technology === "prefab" &&
		scored.insulation === true &&
		scored.floorHeating === true &&
		scored.heatPump === true &&
		scored.recuperation === true &&
		scored.airConditioning === true &&
		scored.photovoltaics === true,
	scored,
);
check(
	"legal status, code lists and tenancy project",
	scored?.legalStatus === "cooperative" &&
		scored.encumbrances.length === 2 &&
		scored.defects.length === 2 &&
		scored.tenanted === false,
	scored,
);
check(
	"the plot projection carries media, access and plan",
	scored?.plot?.type === "budowlana" &&
		scored.plot.mediaCount === 2 &&
		scored.plot.media.water === false &&
		scored.plot.roadAccess === "public" &&
		scored.plot.wz === true &&
		scored.plot.shape === "regular" &&
		scored.plot.slope === "flat" &&
		scored.plot.dimensions === "20x40 m",
	scored?.plot,
);
check(
	"the context projection carries the setting and the view",
	scored?.context?.lake === true &&
		scored.context.forest === true &&
		scored.context.mountains === false &&
		scored.context.view === "widok na jezioro",
	scored?.context,
);
check(
	"monthly costs project verbatim",
	scored?.monthlyCosts?.rent === 1200 &&
		scored.monthlyCosts.agencyFeePct === 2.5,
	scored?.monthlyCosts,
);
const flat = scoredFactsOf({
	heating: "gas",
	buildingType: "block",
	utilities: { power: true },
	condition: "good",
});
check(
	"utilities alone do not make a flat a plot",
	flat?.plot === null && flat.buildingStyle === "block",
	flat,
);
check(
	"a block with prefab technology is a large panel block",
	scoredFactsOf({ buildingType: "block", technology: "prefab" })
		?.buildingStyle === "largePanel" &&
		scoredFactsOf({ buildingType: "detached" })?.buildingStyle === "house",
);
check(
	"a direct large-panel answer wins over the derived style",
	factsOf({ largePanel: true })?.largePanel === true &&
		factsOf({ largePanel: "false" })?.largePanel === false &&
		scoredFactsOf({ largePanel: true, buildingType: "block" })
			?.buildingStyle === "largePanel" &&
		scoredFactsOf({ buildingType: "block" })?.buildingStyle === "block",
);
check(
	"a v1 facts row still projects",
	scoredFactsOf({ heating: "district", buildYear: 1998 })?.heating ===
		"district",
);
check(
	"empty and malformed rows project to null",
	scoredFactsOf(null) === null &&
		scoredFactsOf({}) === null &&
		scoredFactsOf({ heating: "geotermia" }) === null,
);
check(
	"an empty id list loads nothing (no DB roundtrip)",
	(await loadScoredFacts([])).size === 0,
);
check(
	"loadScoredFacts drops non-integer ids before querying",
	(await loadScoredFacts([Number.NaN, 0, -1])).size === 0,
);

// --- Idempotence --------------------------------------------------------
const twice = parseFactsResponse(
	JSON.stringify({
		results: [{ id: 101, heating: "district", buildYear: 2005 }],
	}),
	ids,
);
check(
	"parsing the same answer twice yields the same facts",
	JSON.stringify(twice.get(101)) ===
		JSON.stringify(
			parseFactsResponse(
				JSON.stringify({
					results: [{ id: 101, buildYear: 2005, heating: "district" }],
				}),
				ids,
			).get(101),
		),
);

// --- v3 fields ----------------------------------------------------------
// Prompt v3 widens the vocabulary to what the 2026-11 source sample showed
// is stated in prose and not published structurally: building age/renovation
// evidence, energy class, roof and facade state, parking type, storage,
// water/sewage for houses, holiday amenities, MPZP parameters, and the
// auction/investment metadata.
const v3Keys = [
	"renovationYear",
	"energyClass",
	"elevationState",
	"roofType",
	"roofYear",
	"garret",
	"storageM2",
	"parkingType",
	"balconyGlazed",
	"topFloor",
	"outbuildings",
	"waterSource",
	"sewage",
	"pool",
	"sauna",
	"jacuzzi",
	"strEvidence",
	"plotSubdividable",
	"maxCoveragePct",
	"maxFloors",
	"existingBuilding",
	"appraisedValue",
	"auctionRound",
	"caseNumber",
	"court",
	"landRegister",
	"shareFraction",
	"unitsCount",
	"buildingsCount",
	"constructionStage",
	"finishStandard",
	"siteAmenities",
];
check(
	"the prompt schema carries every v3 key",
	v3Keys.every((key) => system.includes(`"${key}"`)),
	v3Keys.filter((key) => !system.includes(`"${key}"`)),
);

const v3 = normalizeFacts({
	id: 101,
	renovationYear: 2019,
	energyClass: "c",
	elevationState: "elewacja ocieplona",
	roofType: "dachówka",
	roofYear: 2015,
	garret: true,
	storageM2: "4,5",
	parkingType: "hala garażowa",
	balconyGlazed: true,
	topFloor: true,
	outbuildings: true,
	waterSource: "studnia",
	sewage: "szambo",
	pool: true,
	sauna: true,
	jacuzzi: null,
	strEvidence: true,
	plotSubdividable: true,
	maxCoveragePct: 35,
	maxFloors: 1.5,
	existingBuilding: true,
	appraisedValue: 450000,
	auctionRound: "druga licytacja",
	caseNumber: "KM 123/24",
	court: "SR dla Krakowa-Krowodrzy",
	landRegister: "KR1P/00012345/6",
	shareFraction: "1/2",
	unitsCount: 120,
	buildingsCount: 3,
	constructionStage: "stan surowy zamknięty",
	finishStandard: "pod klucz",
	siteAmenities: ["plac zabaw", "siłownia", "Concierge", "plac zabaw"],
});
check(
	"v3 enums accept Polish aliases",
	v3?.energyClass === "C" &&
		v3?.elevationState === "after_insulation" &&
		v3?.roofType === "tile" &&
		v3?.parkingType === "hall" &&
		v3?.waterSource === "well" &&
		v3?.sewage === "septic" &&
		v3?.auctionRound === "second" &&
		v3?.constructionStage === "closed_shell" &&
		v3?.finishStandard === "turnkey",
	{
		energyClass: v3?.energyClass,
		elevationState: v3?.elevationState,
		roofType: v3?.roofType,
		parkingType: v3?.parkingType,
		waterSource: v3?.waterSource,
		sewage: v3?.sewage,
		auctionRound: v3?.auctionRound,
		constructionStage: v3?.constructionStage,
		finishStandard: v3?.finishStandard,
	},
);
check(
	"v3 numbers are parsed and bounded",
	v3?.renovationYear === 2019 &&
		v3?.roofYear === 2015 &&
		v3?.storageM2 === 4.5 &&
		v3?.maxCoveragePct === 35 &&
		v3?.maxFloors === 1.5 &&
		v3?.appraisedValue === 450000 &&
		v3?.unitsCount === 120 &&
		v3?.buildingsCount === 3,
	{
		renovationYear: v3?.renovationYear,
		storageM2: v3?.storageM2,
		maxCoveragePct: v3?.maxCoveragePct,
		appraisedValue: v3?.appraisedValue,
	},
);
check(
	"v3 booleans and text are kept, the amenity list is deduped to codes",
	v3?.garret === true &&
		v3?.balconyGlazed === true &&
		v3?.topFloor === true &&
		v3?.outbuildings === true &&
		v3?.pool === true &&
		v3?.sauna === true &&
		v3?.strEvidence === true &&
		v3?.plotSubdividable === true &&
		v3?.existingBuilding === true &&
		v3?.caseNumber === "KM 123/24" &&
		v3?.shareFraction === "1/2" &&
		v3?.siteAmenities?.length === 3 &&
		v3?.siteAmenities?.includes("plac_zabaw") === true,
	{ siteAmenities: v3?.siteAmenities, caseNumber: v3?.caseNumber },
);

const v3Bad = normalizeFacts({
	id: 102,
	renovationYear: 1200,
	energyClass: "Z",
	maxCoveragePct: 150,
	maxFloors: 40,
	storageM2: -5,
	unitsCount: 99999,
	parkingType: "na dachu",
	siteAmenities: [42, ""],
	auctionRound: "czwarta",
});
check(
	"v3 rejects out-of-range and unknown values instead of guessing",
	v3Bad?.renovationYear === null &&
		v3Bad?.energyClass === null &&
		v3Bad?.maxCoveragePct === null &&
		v3Bad?.maxFloors === null &&
		v3Bad?.storageM2 === null &&
		v3Bad?.unitsCount === null &&
		v3Bad?.parkingType === null &&
		v3Bad?.auctionRound === null &&
		v3Bad?.siteAmenities === null,
	{
		energyClass: v3Bad?.energyClass,
		parkingType: v3Bad?.parkingType,
		siteAmenities: v3Bad?.siteAmenities,
	},
);

const v3Costs = normalizeFacts({
	id: 103,
	monthlyCosts: { rent: 650, funduszRemontowy: 120, deposit: 3000 },
});
check(
	"the deposit joins the monthly cost block",
	v3Costs?.monthlyCosts?.rent === 650 &&
		v3Costs?.monthlyCosts?.funduszRemontowy === 120 &&
		v3Costs?.monthlyCosts?.deposit === 3000,
	v3Costs?.monthlyCosts,
);

// --- Once per offer ------------------------------------------------------
// `selectFactCandidates` is the only place the send queue is built, so these
// checks are the run-level and cross-run guarantee.
const candidates = [
	{ id: 201, title: "Mieszkanie A", description: "x".repeat(200) },
	{ id: 201, title: "Mieszkanie A", description: "x".repeat(200) },
	{ id: 202, title: "Mieszkanie B", description: "y".repeat(200) },
];
const firstRun = selectFactCandidates(candidates, { limit: 10 });
check(
	"a run sends each offer at most once (ids are deduped)",
	firstRun.queue.length === 2 && firstRun.duplicates === 1,
	{ queued: firstRun.queue.map((row) => row.id), duplicates: firstRun.duplicates },
);
const hashA = factTextHash("Mieszkanie A", "x".repeat(200));
check(
	"the queue carries the hash of the text the model will read",
	firstRun.queue[0]?.hash === hashA,
	firstRun.queue[0]?.hash,
);
check(
	"the run limit caps the queue",
	selectFactCandidates(candidates, { limit: 1 }).queue.length === 1,
);
const knownA = new Map([
	[201, { hash: hashA, version: FACT_PROMPT_VERSION }],
]);
const secondRun = selectFactCandidates(candidates, {
	limit: 10,
	known: knownA,
});
check(
	"across runs an unchanged text is never sent again",
	!secondRun.queue.some((row) => row.id === 201) && secondRun.skipped === 1,
	{ queued: secondRun.queue.map((row) => row.id), skipped: secondRun.skipped },
);
check(
	"a changed description is sent again",
	selectFactCandidates(
		[{ id: 201, title: "Mieszkanie A", description: "nowy opis" }],
		{ limit: 10, known: knownA },
	).queue.length === 1,
);
check(
	"a prompt bump re-reads the corpus",
	selectFactCandidates(candidates, {
		limit: 10,
		known: knownA,
		version: "999",
	}).queue.some((row) => row.id === 201),
);
check(
	"--force re-reads everything",
	selectFactCandidates(candidates, {
		limit: 10,
		known: knownA,
		force: true,
	}).queue.length === 2,
);
check(
	"the text hash covers the title, the description and the version",
	factTextHash("a", "b") !== factTextHash("a", "c") &&
		factTextHash("a", "b") !== factTextHash("b", "b") &&
		factTextHash("a", "b") !== factTextHash("a", "b", "999"),
);
check(
	"the description window is exactly what the prompt sends",
	promptDescription("a  b\n\nc") === "a b c" &&
		promptDescription("x".repeat(DESCRIPTION_LIMIT + 50)).length ===
			DESCRIPTION_LIMIT &&
		promptDescription(null) === "",
);
const pastWindowA = `${"a".repeat(DESCRIPTION_LIMIT)}AAA`;
const pastWindowB = `${"a".repeat(DESCRIPTION_LIMIT)}BBB`;
check(
	"a description changed only past the window keeps the hash (same request)",
	factTextHash("t", pastWindowA) === factTextHash("t", pastWindowB),
);
check(
	"a description changed inside the window changes the hash",
	factTextHash("t", `${"a".repeat(DESCRIPTION_LIMIT - 1)}X`) !==
		factTextHash("t", `${"a".repeat(DESCRIPTION_LIMIT - 1)}Y`),
);
check(
	"whitespace the prompt collapses does not change the hash",
	factTextHash("t", "a  b") === factTextHash("t", "a b"),
);
const titleOnly = factPrompt([
	{
		id: 301,
		title:
			"Licytacja komornicza: Kraków, ul. Szkolna 5, 52 m², KW KR1P/00012345/6",
		description: null,
	},
]);
check(
	"a title-only offer is sent with an explicit empty description",
	(titleOnly[1]?.content ?? "").includes("OPIS: (brak opisu)") &&
		(titleOnly[1]?.content ?? "").includes("Szkolna"),
);

// --- Empty answers are processed, failed batches are not ----------------
const emptyAnswer = parseFactsAnswer('{"results":[{"id":201}]}', [201, 202]);
check("an all-unknown row is still an answer", emptyAnswer !== null);
const emptyOutcomes = emptyAnswer
	? factRowOutcomes(emptyAnswer, [201, 202])
	: new Map<number, unknown>();
check(
	"an answer with no facts stores an empty result",
	emptyAnswer !== null && emptyOutcomes.get(201) === null,
);
check(
	"a row the model omitted stores an empty result too",
	emptyAnswer !== null && emptyOutcomes.get(202) === null,
);
const storedEmpty = new Map([
	[201, { hash: factTextHash("Mieszkanie A", "x".repeat(200)), version: FACT_PROMPT_VERSION }],
]);
check(
	"a stored empty answer is not re-sent on the next run",
	selectFactCandidates([candidates[0]!], { limit: 10, known: storedEmpty })
		.skipped === 1,
);
const mixedAnswer = parseFactsAnswer(
	'{"results":[{"id":202,"heating":"district"}]}',
	[201, 202],
);
const mixedOutcomes = mixedAnswer
	? factRowOutcomes(mixedAnswer, [201, 202])
	: new Map();
check(
	"a real answer is kept while the omitted row stays empty",
	mixedOutcomes.get(202)?.heating === "district" &&
		mixedOutcomes.get(201) === null,
);
check(
	"an unparseable answer is a failed batch (nothing stored)",
	parseFactsAnswer("no json here", ids) === null &&
		parseFactsAnswer("", ids) === null,
);
check(
	"an answer without a results array is a failed batch",
	parseFactsAnswer('{"error":"rate limited"}', ids) === null &&
		parseFactsAnswer("{}", ids) === null,
);
check(
	"an empty results array is a failed batch, not 10 processed offers",
	parseFactsAnswer('{"results":[]}', ids) === null,
);
// The distinction the rules turn on: an omitted row becomes an empty result
// only after the batch itself parsed; a failed batch exposes no outcomes.
const cleanBatch = parseFactsAnswer(
	'{"results":[{"id":202,"heating":"gas"}]}',
	[201, 202],
);
check(
	"an omitted row is stored as empty only after a cleanly parsed batch",
	cleanBatch !== null &&
		factRowOutcomes(cleanBatch, [201, 202]).get(201) === null &&
		factRowOutcomes(cleanBatch, [201, 202]).get(202)?.heating === "gas",
);
check(
	"a failed batch exposes no outcomes to store",
	parseFactsAnswer("<<garbage>>", [201, 202]) === null,
);

// --- Consumer coverage: facts asked for vs facts read -------------------
const promptSchemaKeys = new Set(
	[
		...(system.match(/Schemat odpowiedzi:.*$/mu)?.[0] ?? "").matchAll(
			/"(\w+)":/gu,
		),
	].map((match) => match[1] ?? ""),
);
promptSchemaKeys.delete("id");
promptSchemaKeys.delete("results");
const promptSources = new Set(Object.values(SCORED_FACT_SOURCES).flat());
check(
	"every prompt key a consumer's fact is derived from is in the schema",
	[...promptSources].every((key) => promptSchemaKeys.has(key)),
	[...promptSources].filter((key) => !promptSchemaKeys.has(key)),
);
const normalizedKeys = new Set(
	Object.keys(normalizeFacts({ id: 0 }) ?? {}),
);
check(
	"every schema key has a normalizer field",
	[...promptSchemaKeys].every((key) => normalizedKeys.has(key)),
	[...promptSchemaKeys].filter((key) => !normalizedKeys.has(key)),
);
check(
	"every normalizer field is in the prompt schema",
	[...normalizedKeys].every((key) => promptSchemaKeys.has(key)),
	[...normalizedKeys].filter((key) => !promptSchemaKeys.has(key)),
);

const consumerFiles = [
	"src/lib/scoring/alert-score.ts",
	"src/lib/scoring/run.ts",
	"src/lib/valuation/offer-model.ts",
	"src/lib/valuation/quality-factor.ts",
	"src/routes/api/alerts.ts",
];
const readSource = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const collected = (pattern: RegExp, source: string) =>
	new Set([...source.matchAll(pattern)].map((match) => match[1] ?? ""));
const factReads = new Set<string>();
const plotReads = new Set<string>();
const contextReads = new Set<string>();
const costReads = new Set<string>();
for (const file of consumerFiles) {
	const source = readSource(file);
	for (const key of collected(/facts\??\.([A-Za-z]\w*)(?![\w(])/gu, source))
		factReads.add(key);
	for (const key of collected(/\bplot\??\.([A-Za-z]\w*)(?![\w(])/gu, source))
		plotReads.add(key);
	for (const key of collected(/\bcontext\??\.([A-Za-z]\w*)(?![\w(])/gu, source))
		contextReads.add(key);
	for (const key of collected(
		/\bmonthlyCosts\??\.([A-Za-z]\w*)(?![\w(])/gu,
		source,
	))
		costReads.add(key);
}
const unknown = (reads: Set<string>, allowed: readonly string[]) =>
	[...reads].filter((key) => !allowed.includes(key));
check(
	"every fact a consumer reads is in the ScoredFacts projection",
	unknown(factReads, SCORED_FACTS_KEYS).length === 0,
	unknown(factReads, SCORED_FACTS_KEYS),
);
check(
	"every plot field a consumer reads is projected",
	unknown(plotReads, FACTS_PLOT_KEYS).length === 0,
	unknown(plotReads, FACTS_PLOT_KEYS),
);
check(
	"every context field a consumer reads is projected",
	unknown(contextReads, FACTS_CONTEXT_KEYS).length === 0,
	unknown(contextReads, FACTS_CONTEXT_KEYS),
);
check(
	"every cost field a consumer reads is projected",
	unknown(costReads, FACTS_MONTHLY_COST_KEYS).length === 0,
	unknown(costReads, FACTS_MONTHLY_COST_KEYS),
);
const projection = scoredFactsOf({
	heating: "district",
	buildingType: "tenement",
	condition: "good",
	market: "secondary",
	utilities: { power: true },
	context: { lake: true },
	monthlyCosts: { rent: 500 },
	defects: ["damp"],
});
check(
	"the projection exposes exactly the declared keys",
	projection != null &&
		Object.keys(projection).sort().join(",") ===
			[...SCORED_FACTS_KEYS].sort().join(","),
	projection == null ? null : Object.keys(projection).sort(),
);
for (const field of ["buildingStyle", "market", "condition"] as const) {
	check(
		`the projection maps ${field}`,
		projection?.[field] != null,
		projection?.[field],
	);
}

// No consumer may call the model: exactly one module in src/ does.
const srcFiles = (readdirSync(join(process.cwd(), "src"), {
	recursive: true,
	withFileTypes: true,
}) as unknown as Array<{ name: string; parentPath?: string; path?: string }>)
	.map((entry) => {
		const dir = entry.parentPath ?? entry.path ?? "";
		return relative(process.cwd(), join(dir, entry.name));
	})
	.filter((path) => /\.(ts|tsx)$/u.test(path));
const modelCallers = srcFiles
	// client.ts defines the transport; every other match must be a call site.
	.filter((path) => path !== "src/lib/llm/client.ts")
	.filter((path) => /chatText\s*\(/u.test(readSource(path)));
check(
	"the model is called from extract.ts only (scoring/alerting never)",
	modelCallers.length === 1 && modelCallers[0] === "src/lib/llm/extract.ts",
	modelCallers,
);
// The per-offer order is the contract: scrape -> facts -> store -> score. A
// regression here silently restores the old "score first, extract later"
// behaviour, which is exactly what let an electric-heated flat alert as
// "heating unconfirmed".
const pipelineSource = readSource("src/crawler/pipeline.ts");
const factsStepAt = pipelineSource.indexOf("yield* factsEffect");
const saveStepAt = pipelineSource.indexOf("yield* saveEffect");
const scoreStepAt = pipelineSource.indexOf("yield* arrivalScoringEffect");
check(
	"the crawl reads facts before it stores, and scores after storing",
	factsStepAt > 0 &&
		saveStepAt > factsStepAt &&
		scoreStepAt > saveStepAt,
	{ factsStepAt, saveStepAt, scoreStepAt },
);
check(
	"no consumer file imports the LLM client",
	consumerFiles.every((file) => {
		const source = readSource(file);
		return !/llm\/client|chatText|openaiCompatibleText/u.test(source);
	}),
);

// --- Batching by payload, not by row count ------------------------------
// Whole ads can be long, so a request is bounded by characters and sends
// fewer offers instead of truncated prose. A fact in the last paragraph is
// exactly what the short window used to lose.
const longAds = Array.from({ length: FACT_BATCH_SIZE }, (_, index) => ({
	id: 900 + index,
	title: `Mieszkanie ${index}`,
	description: "ogrzewanie miejskie, kamienica, po remoncie. ".repeat(100),
}));
const longBatches = factBatches(longAds);
const promptChars = (batch: typeof longAds): number => {
	const [system, user] = factPrompt(batch);
	return (system?.content.length ?? 0) + (user?.content.length ?? 0);
};
console.log(
	`     prompt: ${longBatches.length} request(s) for ${FACT_BATCH_SIZE} long ads, ` +
		`largest ${Math.max(...longBatches.map(promptChars))} chars ` +
		`(budget ${FACT_BATCH_CHAR_BUDGET}, ${DESCRIPTION_LIMIT} chars per ad)`,
);
check(
	"a whole-ad prompt is split by payload, so no request exceeds the budget",
	longBatches.length > 1 &&
		longBatches.every(
			(batch) =>
				batch.reduce((sum, row) => sum + factPromptCost(row), 0) <=
				FACT_BATCH_CHAR_BUDGET,
		),
	{ batches: longBatches.length, chars: longBatches.map(promptChars) },
);
check(
	"batching keeps every offer in exactly one batch, in order",
	longBatches
		.flat()
		.map((row) => row.id)
		.join(",") === longAds.map((row) => row.id).join(","),
);
const huge = [
	{ id: 950, title: "Ad", description: "x".repeat(DESCRIPTION_LIMIT) },
];
const hugeBatches = factBatches(huge, 10, 5_000);
check(
	"one ad larger than the budget is sent alone, not truncated",
	hugeBatches.length === 1 &&
		hugeBatches[0]?.length === 1 &&
		(factPrompt(hugeBatches[0] ?? [])[1]?.content.includes("x".repeat(500)) ??
			false),
);
check(
	"the prompt carries the whole stored description",
	promptDescription("y".repeat(DESCRIPTION_LIMIT + 50)).length ===
		DESCRIPTION_LIMIT,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
