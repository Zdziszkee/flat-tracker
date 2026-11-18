/**
 * Listing facts extracted from the title and description by a model.
 *
 * The portals leave most physical facts out of their structured fields (the
 * bulk feeds publish no heating, no building style, no condition), yet
 * sellers state them in prose. A regular expression catches the obvious
 * "ogrzewanie miejskie" and nothing else, so a model reads the text and
 * returns the small enum set the scoring layer already understands.
 *
 * Everything here is pure: prompt construction, response parsing and
 * normalization. Writing to the database lives in `extract.ts`, so this
 * module stays testable without a network or a DB (`validate:facts`).
 *
 * The model is a data source, not a trusted one: unknown ids are dropped,
 * values outside the allowed sets become null, numbers outside a plausible
 * range become null, and a fact the text does not state must be "unknown".
 */

/** The enum vocabulary, one entry per column the extraction may fill. */
export const FACT_VALUES = {
	heating: [
		"district",
		"heatPump",
		"gas",
		"electric",
		"coalWood",
		"oil",
		"unknown",
	],
	buildingType: [
		"block",
		"apartment",
		"tenement",
		"semi_detached",
		"townhouse",
		"detached",
		"house",
		"unknown",
	],
	plotType: [
		"budowlana",
		"rolna",
		"rekreacyjna",
		"siedliskowa",
		"lesna",
		"inwestycyjna",
		"unknown",
	],
	buildingMaterial: [
		"brick",
		"concrete",
		"cellular_concrete",
		"wood",
		"unknown",
	],
	condition: ["excellent", "very_good", "good", "to_renovation", "unknown"],
	ownership: ["full_ownership", "leasehold", "share", "unknown"],
} as const;

export type FactEnumField = keyof typeof FACT_VALUES;

export interface ListingFacts {
	heating: string | null;
	buildingType: string | null;
	plotType: string | null;
	buildingMaterial: string | null;
	condition: string | null;
	ownership: string | null;
	buildYear: number | null;
	plotAreaM2: number | null;
	floor: number | null;
	floorCount: number | null;
	hasBalcony: boolean | null;
	hasTerrace: boolean | null;
	hasGarden: boolean | null;
	hasElevator: boolean | null;
	hasParking: boolean | null;
	hasGarage: boolean | null;
	hasBasement: boolean | null;
}

/** One offer as the prompt sees it. Descriptions are trimmed: the header and
 * the price/area block carry the facts, the marketing tail does not. */
export interface FactInput {
	id: number;
	title: string;
	description: string | null;
}

export const FACT_PROMPT_VERSION = "1";

/** Longest description slice sent per listing; ~700 chars covers the facts. */
const DESCRIPTION_LIMIT = 900;

/** Listings per request: one bad answer then costs one batch, not one offer. */
export const FACT_BATCH_SIZE = 10;

export function factPrompt(listings: FactInput[]): Array<{
	role: "system" | "user";
	content: string;
}> {
	const system = [
		"Jesteś ekstraktorem danych z polskich ogłoszeń nieruchomości.",
		"Odpowiadasz WYŁĄCZNIE obiektem JSON, bez komentarzy i bez markdown.",
		"Wypełniaj pole tylko wtedy, gdy wynika ono wprost z tekstu ogłoszenia.",
		'Nie zgaduj. Brak informacji to zawsze "unknown" (albo null dla liczb).',
		"",
		"Dozwolone wartości:",
		`heating: ${FACT_VALUES.heating.join("|")}`,
		"  district = ogrzewanie miejskie, z sieci miejskiej, MPEC, ciepło systemowe, elektrociepłownia",
		"  heatPump = pompa ciepła; coalWood = węgiel, drewno, kominek; oil = olejowe",
		`buildingType: ${FACT_VALUES.buildingType.join("|")}`,
		"  block = blok, wielka płyta; tenement = kamienica; apartment = apartamentowiec, nowe budownictwo",
		`plotType: ${FACT_VALUES.plotType.join("|")}`,
		`buildingMaterial: ${FACT_VALUES.buildingMaterial.join("|")}`,
		"  cellular_concrete = pustak, silka, beton komórkowy",
		`condition: ${FACT_VALUES.condition.join("|")}`,
		"  excellent = nowe/po generalnym remoncie; very_good = bardzo dobry; good = dobry; to_renovation = do remontu",
		`ownership: ${FACT_VALUES.ownership.join("|")}`,
		"  leasehold = użytkowanie wieczyste; share = udział, współwłasność",
		"Liczby: buildYear (1800-2035), plotAreaM2 (powierzchnia działki w m2), floor (0 = parter, -1 = piwnica/suterena), floorCount (liczba pięter w budynku).",
		"Booleany (true/false/null): hasBalcony, hasTerrace, hasGarden, hasElevator, hasParking, hasGarage, hasBasement.",
		"",
		`Odpowiedz dokładnie: {"results":[{...}]} z jednym obiektem na ogłoszenie, w tej samej kolejności, każdy z polem "id".`,
	].join("\n");
	const body = listings
		.map((listing) => {
			const description = (listing.description ?? "")
				.replace(/\s+/gu, " ")
				.trim()
				.slice(0, DESCRIPTION_LIMIT);
			return `[${listing.id}]\nTYTUŁ: ${listing.title}\nOPIS: ${description || "(brak opisu)"}`;
		})
		.join("\n\n");
	return [
		{ role: "system", content: system },
		{ role: "user", content: body },
	];
}

/** Strip code fences and prose around the JSON object the model returned. */
export function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u);
	const candidate = fenced?.[1]?.trim() ?? trimmed;
	try {
		return JSON.parse(candidate);
	} catch {
		// Text around the payload ("Oto wynik: {...}") is common.
	}
	const start = candidate.search(/[{[]/u);
	const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(candidate.slice(start, end + 1));
	} catch {
		return null;
	}
}

function asEnum(value: unknown, allowed: readonly string[]): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase();
	if (!text) return null;
	const match = allowed.find((entry) => entry.toLowerCase() === text);
	if (match) return match === "unknown" ? null : match;
	// A few models answer with the Polish word instead of the token.
	const aliases: Record<string, string> = {
		miejskie: "district",
		"z sieci miejskiej": "district",
		mpec: "district",
		gazowe: "gas",
		elektryczne: "electric",
		"pompa ciepła": "heatPump",
		węglowe: "coalWood",
		kamienica: "tenement",
		blok: "block",
		"wielka płyta": "block",
		leśna: "lesna",
	};
	const alias = aliases[text];
	if (alias && allowed.includes(alias)) return alias;
	return null;
}

function asBoolean(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
}

function asNumber(
	value: unknown,
	minimum: number,
	maximum: number,
): number | null {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseFloat(value.replace(",", "."))
				: Number.NaN;
	if (!Number.isFinite(number)) return null;
	if (number < minimum || number > maximum) return null;
	return number;
}

/**
 * One record from the model answer, or null when the row is unusable (no id,
 * not an object). Range checks are wide on purpose: they catch a swapped
 * field ("2024" poked into floorCount), not a judgement call.
 */
export function normalizeFacts(raw: unknown): ListingFacts | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	const facts: ListingFacts = {
		heating: asEnum(row.heating, FACT_VALUES.heating),
		buildingType: asEnum(row.buildingType, FACT_VALUES.buildingType),
		plotType: asEnum(row.plotType, FACT_VALUES.plotType),
		buildingMaterial: asEnum(
			row.buildingMaterial,
			FACT_VALUES.buildingMaterial,
		),
		condition: asEnum(row.condition, FACT_VALUES.condition),
		ownership: asEnum(row.ownership, FACT_VALUES.ownership),
		buildYear: asNumber(row.buildYear, 1800, 2035),
		plotAreaM2: asNumber(row.plotAreaM2, 1, 500_000),
		floor: asNumber(row.floor, -3, 60),
		floorCount: asNumber(row.floorCount, 1, 80),
		hasBalcony: asBoolean(row.hasBalcony),
		hasTerrace: asBoolean(row.hasTerrace),
		hasGarden: asBoolean(row.hasGarden),
		hasElevator: asBoolean(row.hasElevator),
		hasParking: asBoolean(row.hasParking),
		hasGarage: asBoolean(row.hasGarage),
		hasBasement: asBoolean(row.hasBasement),
	};
	return facts;
}

/** Every fact null means the model had nothing to add: not worth storing. */
export function isEmptyFacts(facts: ListingFacts): boolean {
	return Object.values(facts).every((value) => value === null);
}

/**
 * Map the model answer back to the requested ids. A row whose id was not
 * requested is ignored, and a listing missing from the answer simply gets no
 * facts this round.
 */
export function parseFactsResponse(
	text: string,
	requested: readonly number[],
): Map<number, ListingFacts> {
	const parsed = extractJsonObject(text);
	const rows = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object"
			? ((parsed as { results?: unknown }).results ?? [])
			: [];
	if (!Array.isArray(rows)) return new Map();
	const allowed = new Set(requested);
	const out = new Map<number, ListingFacts>();
	for (const row of rows) {
		const id = Number(
			(row as { id?: unknown } | null)?.id ??
				(row as { listingId?: unknown } | null)?.listingId,
		);
		if (!Number.isFinite(id) || !allowed.has(id)) continue;
		const facts = normalizeFacts(row);
		if (facts) out.set(id, facts);
	}
	return out;
}
