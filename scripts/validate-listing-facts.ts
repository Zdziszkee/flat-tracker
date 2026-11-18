/**
 * Validation for model-extracted listing facts (pure, no network, no DB).
 *
 *   bun run validate:facts
 *
 * The model is a data source, not a trusted one, so the parsing and
 * normalization rules are pinned here: enum vocabulary, Polish aliases,
 * range checks, unknown ids, code fences, nested v2 objects (utilities,
 * monthly costs, context), list sanitation, the fact-access projections the
 * scoring/valuation layers read, and the prompt contract the model is asked
 * to follow.
 */
import {
	FACT_PROMPT_VERSION,
	FACT_VALUES,
	extractJsonObject,
	factPrompt,
	isEmptyFacts,
	normalizeFacts,
	parseFactsResponse,
} from "#/lib/llm/listing-facts.ts";
import {
	clearFactCache,
	conditionOf,
	contextOf,
	defectListOf,
	factCacheSize,
	factsFor,
	monthlyCostOf,
	parseFactsJson,
	plotAccessOf,
	plotMediaOf,
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
	"the prompt version is 2",
	FACT_PROMPT_VERSION === "2",
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
	"the system prompt describes the v2 nested objects",
	["utilities", "monthlyCosts", "context", "defects", "encumbrances"].every(
		(key) => system.includes(key),
	),
);
check(
	"the system prompt forbids guessing",
	/nie zgaduj/iu.test(system) && /unknown/iu.test(system),
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
const topLevelArray = '[{"id":102,"heating":"district"}]';
check(
	"a bare array answer is parsed",
	parseFactsResponse(topLevelArray, ids).get(102)?.heating === "district",
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

// --- Enum normalization -------------------------------------------------
function factsOf(raw: Record<string, unknown>) {
	return normalizeFacts({ id: 1, ...raw });
}
check(
	"unknown means null, not a stored value",
	factsOf({ heating: "unknown" })?.heating === null,
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
	factsOf({ roadAccess: "asfalt" })?.roadAccess === "asphalt" &&
		factsOf({ mpzpPurpose: "MN/U" })?.mpzpPurpose ===
			"residential_services" &&
		factsOf({ legalStatus: "spółdzielcze własnościowe" })?.legalStatus ===
			"cooperative" &&
		factsOf({ kitchen: "aneks" })?.kitchen === "annex" &&
		factsOf({ windows: "3-szybowe" })?.windows === "triple_glazed" &&
		factsOf({ technology: "murowana" })?.technology === "traditional",
);
check(
	"an unrecognized enum value becomes null",
	factsOf({ condition: "swietny" })?.condition === null &&
		factsOf({ heating: "geotermia" })?.heating === null &&
		factsOf({ roadAccess: "autostrada" })?.roadAccess === null,
);
check(
	"enum matching is case and whitespace insensitive",
	factsOf({ heating: "  District " })?.heating === "district",
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

// --- v2 nested fields ---------------------------------------------------
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
		river: false,
		forest: "true",
		mountains: null,
		view: true,
	},
	defects: [
		"4. piętro bez windy",
		"<b>media do doprowadzenia</b>",
		"4. piętro bez windy",
		"",
		42,
	],
	encumbrances: ["hipoteka"],
	roadAccess: "asfalt",
	roadPublic: true,
	mpzpSymbol: "MN/U",
	mpzpPurpose: "mieszkaniowa",
	buildingPermitWz: true,
	plotShape: "prostokątna",
	plotDimensions: "20x40 m",
	plotSlope: "płaska",
	fencing: true,
	kitchen: "aneks",
	exposure: "wschód-zachód",
	windows: "trzy szybowe",
	technology: "murowana",
	insulation: true,
	floorHeating: true,
	heatPump: true,
	recuperation: true,
	ac: true,
	pv: true,
	parkingSpots: "2 miejsca",
	balconyM2: "6",
	terraceM2: 0,
	gardenM2: "120",
	garageM2: 18,
	legalStatus: "spółdzielcze własnościowe",
	tenanted: false,
	urgency: "pilne",
});
check(
	"utilities parse per utility and keep false",
	rich?.utilities?.power === true &&
		rich.utilities.water === false &&
		rich.utilities.gas === null &&
		rich.utilities.sewer === true &&
		rich.utilities.internet === null,
	rich?.utilities,
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
	"context parses the setting flags",
	rich?.context?.lake === true &&
		rich.context.river === false &&
		rich.context.forest === true &&
		rich.context.mountains === null &&
		rich.context.view === true,
	rich?.context,
);
check(
	"defects are sanitized, deduped and limited",
	rich?.defects?.length === 2 &&
		rich.defects[0] === "4. piętro bez windy" &&
		rich.defects[1] === "media do doprowadzenia",
	rich?.defects,
);
check(
	"encumbrances parse as a list",
	rich?.encumbrances?.length === 1 &&
		rich.encumbrances[0] === "hipoteka",
	rich?.encumbrances,
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
	"nested objects with no stated value become null",
	factsOf({ utilities: { power: null } })?.utilities === null &&
		factsOf({ monthlyCosts: {} })?.monthlyCosts === null &&
		factsOf({ context: { lake: null } })?.context === null,
);
check(
	"a string list entry is not split on commas",
	factsOf({ defects: "4. piętro, bez windy" })?.defects?.[0] ===
		"4. piętro, bez windy",
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
	"a non-empty nested object counts as facts",
	!isEmptyFacts(rich ?? ({} as never)) &&
		isEmptyFacts(factsOf({}) ?? ({} as never)),
);

// --- Fact-access projections -------------------------------------------
const media = plotMediaOf(rich);
check(
	"plot media counts connected utilities",
	media.connectedCount === 2 &&
		media.anyConnected === true &&
		media.coreConnected === false,
	media,
);
const access = plotAccessOf(rich);
check(
	"plot access reads road, plan and WZ evidence",
	access.hasPublicAccess === true &&
		access.hasPlanEvidence === true &&
		access.mediaConnected === true &&
		access.buildableEvidence === true,
	access,
);
const noEvidence = plotAccessOf(
	factsOf({
		utilities: { power: false, water: false },
		roadAccess: "none",
		roadPublic: false,
		buildingPermitWz: false,
	}),
);
check(
	"a plot with no media, access or plan has no buildable evidence",
	noEvidence.mediaConnected === false &&
		noEvidence.hasPublicAccess === false &&
		noEvidence.hasPlanEvidence === false &&
		noEvidence.buildableEvidence === false,
	noEvidence,
);
const context = contextOf(rich);
check(
	"context facts count the affirmed settings",
	context.settingCount === 3 && context.hasSetting === true,
	context,
);
check(
	"defect list merges defects and encumbrances",
	defectListOf(rich).length === 3 &&
		defectListOf(rich).includes("hipoteka"),
	defectListOf(rich),
);
const signals = conditionOf(rich);
check(
	"condition signals carry quality and legal fields",
	signals.condition === null &&
		signals.technology === "traditional" &&
		signals.insulation === true &&
		signals.floorHeating === true &&
		signals.legalStatus === "cooperative" &&
		signals.defectCount === 3,
	signals,
);
check(
	"monthly cost reader returns the nested object",
	monthlyCostOf(rich)?.rent === 1200,
	monthlyCostOf(rich),
);
check(
	"projections tolerate absent facts",
	plotMediaOf(null).anyConnected === false &&
		plotAccessOf(null).buildableEvidence === false &&
		contextOf(null).hasSetting === false &&
		defectListOf(null).length === 0 &&
		conditionOf(null).defectCount === 0,
);

// --- Stored JSON and cache ---------------------------------------------
check(
	"stored facts JSON is normalized on read",
	parseFactsJson(JSON.stringify({ heating: "miejskie" }))?.heating ===
		"district" && parseFactsJson("{bad") === null,
);
clearFactCache();
check(
	"the cache starts empty and an unloaded id reads as null",
	factCacheSize() === 0 && factsFor(101) === null,
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
