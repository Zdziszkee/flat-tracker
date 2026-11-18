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
 */
import {
	EXPOSURE_TOKENS,
	FACT_PROMPT_VERSION,
	FACT_VALUES,
	asExposure,
	extractJsonObject,
	factPrompt,
	isEmptyFacts,
	normalizeFacts,
	parseFactsResponse,
} from "#/lib/llm/listing-facts.ts";
import { loadScoredFacts, scoredFactsOf } from "#/lib/llm/fact-access.ts";

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
