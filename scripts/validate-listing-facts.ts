/**
 * Validation for model-extracted listing facts (pure, no network, no DB).
 *
 *   bun run validate:facts
 *
 * The model is a data source, not a trusted one, so the parsing and
 * normalization rules are pinned here: enum vocabulary, Polish aliases,
 * range checks, unknown ids, code fences, and the prompt contract the model
 * is asked to follow.
 */
import {
	FACT_PROMPT_VERSION,
	FACT_VALUES,
	factPrompt,
	extractJsonObject,
	isEmptyFacts,
	normalizeFacts,
	parseFactsResponse,
} from "#/lib/llm/listing-facts.ts";

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
	"the system prompt lists every heating token",
	FACT_VALUES.heating.every((value) => system.includes(value)),
	FACT_VALUES.heating,
);
check(
	"the system prompt lists every building type token",
	FACT_VALUES.buildingType.every((value) => system.includes(value)),
	FACT_VALUES.buildingType,
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
check("the prompt version is a non-empty literal", FACT_PROMPT_VERSION.length > 0);

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
	"an unrecognized enum value becomes null",
	factsOf({ condition: "swietny" })?.condition === null &&
		factsOf({ heating: "geotermia" })?.heating === null,
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
