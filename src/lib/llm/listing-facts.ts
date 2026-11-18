/**
 * Listing facts extracted from the title and description by a model.
 *
 * The portals leave most physical facts out of their structured fields (the
 * bulk feeds publish no heating, no building style, no condition), yet
 * sellers state them in prose. A regular expression catches the obvious
 * "ogrzewanie miejskie" and nothing else, so a model reads the text and
 * returns the small enum set the scoring layer already understands. Prompt
 * v2 widens the schema to the facts a 120-offer probe measured as present
 * and useful: plot utilities and access, defects, legal status, exact
 * monthly costs, kitchen/exposure/windows, building technology and the
 * setting around a plot or house.
 *
 * Everything here is pure: prompt construction, response parsing and
 * normalization. Writing to the database lives in `extract.ts`, reading it
 * back in `fact-access.ts`, so this module stays testable without a network
 * or a DB (`validate:facts`).
 *
 * The model is a data source, not a trusted one: unknown ids are dropped,
 * values outside the allowed sets become null, numbers outside a plausible
 * range become null, free text is bounded, and a fact the text does not
 * state must be "unknown".
 */

/** The enum vocabulary, one entry per enum column the extraction may fill. */
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
	/** Access to the plot: asphalt, paved (utwardzona), gravel, dirt, none. */
	roadAccess: ["asphalt", "paved", "gravel", "dirt", "none", "unknown"],
	/** MPZP purpose, mapped from the plan symbol the ad quotes. */
	mpzpPurpose: [
		"residential",
		"residential_services",
		"multi_family",
		"services",
		"agricultural",
		"forest",
		"mixed",
		"other",
		"unknown",
	],
	plotShape: [
		"regular",
		"irregular",
		"elongated",
		"narrow",
		"trapezoid",
		"unknown",
	],
	plotSlope: ["flat", "gentle", "steep", "unknown"],
	/** Kitchen layout: a separate room, an annex, or open to the living room. */
	kitchen: ["separate", "annex", "open", "unknown"],
	/** Window orientation of the flat. */
	exposure: [
		"south",
		"north",
		"east",
		"west",
		"east_west",
		"north_south",
		"multiple",
		"unknown",
	],
	windows: ["pvc", "wood", "aluminium", "triple_glazed", "unknown"],
	technology: [
		"traditional",
		"frame",
		"prefab",
		"monolithic",
		"timber",
		"unknown",
	],
	/** Mortgage-ability of the title, independent of the ownership enum. */
	legalStatus: ["kw", "cooperative", "share_land", "no_deed", "unknown"],
	urgency: ["urgent", "motivated", "unknown"],
} as const;

export type FactEnumField = keyof typeof FACT_VALUES;

/** Utilities connected on a plot. `null` means the text did not say. */
export interface PlotUtilities {
	power: boolean | null;
	water: boolean | null;
	gas: boolean | null;
	sewer: boolean | null;
	internet: boolean | null;
}

/** Monthly costs quoted in the ad, PLN. */
export interface MonthlyCosts {
	/** Czynsz administracyjny. */
	rent: number | null;
	/** Fundusz remontowy. */
	funduszRemontowy: number | null;
	/** Whether media are part of the rent. */
	mediaIncluded: boolean | null;
	/** Zaliczka na media, when quoted separately. */
	advance: number | null;
	/** Agency commission, percent of the price. */
	agencyFeePct: number | null;
}

/** Setting the description claims for a plot or house. */
export interface FactContext {
	lake: boolean | null;
	river: boolean | null;
	forest: boolean | null;
	mountains: boolean | null;
	view: boolean | null;
}

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
	// --- v2 ---------------------------------------------------------------
	utilities: PlotUtilities | null;
	roadAccess: string | null;
	roadPublic: boolean | null;
	mpzpSymbol: string | null;
	mpzpPurpose: string | null;
	buildingPermitWz: boolean | null;
	plotShape: string | null;
	plotDimensions: string | null;
	plotSlope: string | null;
	fencing: boolean | null;
	kitchen: string | null;
	exposure: string | null;
	windows: string | null;
	technology: string | null;
	insulation: boolean | null;
	floorHeating: boolean | null;
	heatPump: boolean | null;
	recuperation: boolean | null;
	ac: boolean | null;
	pv: boolean | null;
	parkingSpots: number | null;
	balconyM2: number | null;
	terraceM2: number | null;
	gardenM2: number | null;
	garageM2: number | null;
	legalStatus: string | null;
	encumbrances: string[] | null;
	defects: string[] | null;
	monthlyCosts: MonthlyCosts | null;
	context: FactContext | null;
	tenanted: boolean | null;
	urgency: string | null;
}

/** One offer as the prompt sees it. Descriptions are trimmed: the header and
 * the price/area block carry the facts, the marketing tail does not. */
export interface FactInput {
	id: number;
	title: string;
	description: string | null;
}

/** Bumped whenever the prompt or the stored schema changes: the version is
 * part of the text hash, so a new prompt re-reads the whole corpus. */
export const FACT_PROMPT_VERSION = "2";

/** Longest description slice sent per listing; ~900 chars covers the facts. */
const DESCRIPTION_LIMIT = 900;

/** Listings per request: one bad answer then costs one batch, not one offer. */
export const FACT_BATCH_SIZE = 10;

const ENUM_HINTS: Record<FactEnumField, string[]> = {
	heating: [
		"district = ogrzewanie miejskie, z sieci miejskiej, MPEC, ciepło systemowe, elektrociepłownia",
		"heatPump = pompa ciepła; coalWood = węgiel, drewno, kominek; oil = olejowe",
	],
	buildingType: [
		"block = blok, wielka płyta; tenement = kamienica; apartment = apartamentowiec, nowe budownictwo",
		"semi_detached = bliźniak; townhouse = szeregowiec; detached = wolnostojący; house = dom",
	],
	plotType: [
		"budowlana = działka budowlana; rolna = rolna; rekreacyjna = rekreacyjna, letniskowa",
		"siedliskowa = siedliskowa; lesna = leśna; inwestycyjna = inwestycyjna",
	],
	buildingMaterial: ["cellular_concrete = pustak, silka, beton komórkowy"],
	condition: [
		"excellent = nowe/po generalnym remoncie; very_good = bardzo dobry; good = dobry; to_renovation = do remontu",
	],
	ownership: [
		"leasehold = użytkowanie wieczyste; share = udział, współwłasność",
	],
	roadAccess: [
		"asphalt = asfalt; paved = utwardzona, kostka; gravel = żwir, tłuczeń; dirt = gruntowa; none = brak dojazdu",
	],
	mpzpPurpose: [
		"MN = residential; MN/U = residential_services; MW = multi_family; U = services; R/RM = agricultural; ZL = forest",
	],
	plotShape: [
		"regular = prostokątna, foremna; irregular = nieregularna; elongated = wydłużona; narrow = wąska; trapezoid = trapez",
	],
	plotSlope: [
		"flat = płaska, równa; gentle = lekki spadek; steep = stroma, skarpa",
	],
	kitchen: [
		"separate = oddzielna kuchnia; annex = aneks kuchenny; open = otwarta na salon",
	],
	exposure: [
		"south/north/east/west = jedna strona; east_west = wschód-zachód; north_south = północ-południe; multiple = dwustronna, wielostronna",
	],
	windows: [
		"pvc = plastikowe; wood = drewniane; aluminium = aluminiowe; triple_glazed = trzyszybowe, 3-szybowe",
	],
	technology: [
		"traditional = murowana, tradycyjna; frame = szkieletowa; prefab = prefabrykowana; monolithic = monolityczna; timber = drewniana",
	],
	legalStatus: [
		"kw = księga wieczysta; cooperative = spółdzielcze własnościowe; share_land = udział w gruncie; no_deed = brak KW",
	],
	urgency: [
		"urgent = pilne, szybka sprzedaż; motivated = możliwa negocjacja, elastyczny termin",
	],
};

function enumLine(field: FactEnumField): string {
	return [
		`${field}: ${FACT_VALUES[field].join("|")}`,
		...ENUM_HINTS[field],
	].join("\n");
}

export function factPrompt(listings: FactInput[]): Array<{
	role: "system" | "user";
	content: string;
}> {
	const system = [
		"Jesteś ekstraktorem danych z polskich ogłoszeń nieruchomości.",
		"Odpowiadasz WYŁĄCZNIE obiektem JSON, bez komentarzy i bez markdown.",
		"Wypełniaj pole tylko wtedy, gdy wynika ono wprost z tekstu ogłoszenia.",
		'Nie zgaduj. Brak informacji to "unknown" (enum), null (liczba, boolean) albo [] (lista).',
		"Wartość false jest informacją: brak windy, media do doprowadzenia, brak dojazdu to false, nie unknown.",
		"",
		"Dozwolone wartości:",
		...Object.keys(FACT_VALUES).map((field) =>
			enumLine(field as FactEnumField),
		),
		"",
		"Liczby: buildYear (1800-2035), plotAreaM2 (m2 działki), floor (0 = parter, -1 = piwnica/suterena), floorCount (pięter w budynku), parkingSpots (liczba miejsc), balconyM2, terraceM2, gardenM2, garageM2 (m2).",
		"Booleany (true/false/null): hasBalcony, hasTerrace, hasGarden, hasElevator, hasParking, hasGarage, hasBasement, roadPublic, buildingPermitWz (decyzja WZ), fencing, insulation, floorHeating, heatPump, recuperation, ac, pv, tenanted.",
		"",
		"Pola złożone:",
		'utilities: {"power":bool|null,"water":bool|null,"gas":bool|null,"sewer":bool|null,"internet":bool|null} — przyłącza NA DZIAŁCE; "media do doprowadzenia" = false, "wszystkie media" = true.',
		'monthlyCosts: {"rent":liczba|null,"funduszRemontowy":liczba|null,"mediaIncluded":bool|null,"advance":liczba|null,"agencyFeePct":liczba|null} — miesięczne koszty w zł, prowizja w %.',
		'context: {"lake":bool|null,"river":bool|null,"forest":bool|null,"mountains":bool|null,"view":bool|null} — otoczenie wymienione w opisie ("nad jeziorem", "obok lasu", "widok na góry").',
		'defects: string[] — wady i ryzyka, np. "4. piętro bez windy", "brak mediów", "media do doprowadzenia", "strefa ochronna GZWP".',
		"encumbrances: string[] — obciążenia prawne, np. hipoteka, służebność, roszczenia.",
		'mpzpSymbol: krótki symbol z planu (np. MN, MN/U, MW, U, R, ZL), mpzpPurpose: enum powyżej; plotDimensions: np. "20x40 m".',
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

/** Polish word -> token aliases the model occasionally answers with. */
const ENUM_ALIASES: Record<string, string> = {
	miejskie: "district",
	"z sieci miejskiej": "district",
	mpec: "district",
	"ciepło systemowe": "district",
	gazowe: "gas",
	gaz: "gas",
	elektryczne: "electric",
	"pompa ciepła": "heatPump",
	węglowe: "coalWood",
	drewno: "coalWood",
	kominek: "coalWood",
	olejowe: "oil",
	kamienica: "tenement",
	blok: "block",
	"wielka płyta": "block",
	apartamentowiec: "apartment",
	bliźniak: "semi_detached",
	szeregowiec: "townhouse",
	wolnostojący: "detached",
	dom: "house",
	leśna: "lesna",
	lesna: "lesna",
	budowlana: "budowlana",
	rolna: "rolna",
	rekreacyjna: "rekreacyjna",
	siedliskowa: "siedliskowa",
	inwestycyjna: "inwestycyjna",
	pustak: "cellular_concrete",
	silka: "cellular_concrete",
	"beton komórkowy": "cellular_concrete",
	cegła: "brick",
	beton: "concrete",
	nowe: "excellent",
	"po remoncie": "excellent",
	"po generalnym remoncie": "excellent",
	"bardzo dobry": "very_good",
	dobry: "good",
	"do remontu": "to_renovation",
	własność: "full_ownership",
	"pełna własność": "full_ownership",
	"użytkowanie wieczyste": "leasehold",
	udział: "share",
	współwłasność: "share",
	asfalt: "asphalt",
	asfaltowa: "asphalt",
	utwardzona: "paved",
	"kostka bauma": "paved",
	żwir: "gravel",
	tłuczeń: "gravel",
	gruntowa: "dirt",
	brak: "none",
	mn: "residential",
	"mn/u": "residential_services",
	mw: "multi_family",
	u: "services",
	r: "agricultural",
	rm: "agricultural",
	zl: "forest",
	mieszana: "mixed",
	mieszkaniowa: "residential",
	usługowa: "services",
	rolnicza: "agricultural",
	prostokątna: "regular",
	foremna: "regular",
	nieregularna: "irregular",
	wydłużona: "elongated",
	wąska: "narrow",
	trapez: "trapezoid",
	płaska: "flat",
	równa: "flat",
	"lekki spadek": "gentle",
	stroma: "steep",
	skarpa: "steep",
	oddzielna: "separate",
	aneks: "annex",
	otwarta: "open",
	południe: "south",
	południowa: "south",
	północ: "north",
	północna: "north",
	wschód: "east",
	wschodnia: "east",
	zachód: "west",
	zachodnia: "west",
	"wschód-zachód": "east_west",
	"północ-południe": "north_south",
	dwustronna: "multiple",
	plastikowe: "pvc",
	drewniane: "wood",
	aluminiowe: "aluminium",
	"3-szybowe": "triple_glazed",
	"trzy szybowe": "triple_glazed",
	trzyszybowe: "triple_glazed",
	murowana: "traditional",
	tradycyjna: "traditional",
	szkieletowa: "frame",
	prefabrykowana: "prefab",
	monolityczna: "monolithic",
	drewniana: "timber",
	księga: "kw",
	"ksiega wieczysta": "kw",
	"księga wieczysta": "kw",
	"spółdzielcze własnościowe": "cooperative",
	"spoldzielcze wlasnosciowe": "cooperative",
	"udział w gruncie": "share_land",
	"brak kw": "no_deed",
	"brak księgi wieczystej": "no_deed",
	pilne: "urgent",
	"pilna sprzedaż": "urgent",
	"szybka sprzedaż": "urgent",
	negocjacje: "motivated",
	elastyczny: "motivated",
};

function asEnum(value: unknown, allowed: readonly string[]): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase();
	if (!text) return null;
	const match = allowed.find((entry) => entry.toLowerCase() === text);
	if (match) return match === "unknown" ? null : match;
	const alias = ENUM_ALIASES[text];
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
				? Number.parseFloat(value.replace(",", ".").replace(/[^\d.-]/gu, ""))
				: Number.NaN;
	if (!Number.isFinite(number)) return null;
	if (number < minimum || number > maximum) return null;
	return number;
}

function asCount(
	value: unknown,
	minimum: number,
	maximum: number,
): number | null {
	const number = asNumber(value, minimum, maximum);
	return number == null ? null : Math.round(number);
}

function asObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** Free text from the model, bounded and stripped of markup/control chars. */
function asText(value: unknown, maxLength: number): string | null {
	if (typeof value !== "string") return null;
	const text = value
		.replace(/<[^>]*>/gu, " ")
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	if (!text) return null;
	return text.slice(0, maxLength);
}

const MAX_LIST_ITEMS = 8;
const MAX_ITEM_CHARS = 140;

function asStringList(value: unknown): string[] | null {
	const source = Array.isArray(value)
		? value
		: typeof value === "string"
			? [value]
			: [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of source) {
		const text = asText(entry, MAX_ITEM_CHARS);
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(text);
		if (out.length >= MAX_LIST_ITEMS) break;
	}
	return out.length > 0 ? out : null;
}

function booleanRecord<T extends string>(
	value: unknown,
	keys: readonly T[],
): Record<T, boolean | null> | null {
	const source = asObject(value);
	if (!source) return null;
	const out = {} as Record<T, boolean | null>;
	let seen = false;
	for (const key of keys) {
		const parsed = asBoolean(source[key]);
		out[key] = parsed;
		if (parsed != null) seen = true;
	}
	return seen ? out : null;
}

function monthlyCosts(value: unknown): MonthlyCosts | null {
	const source = asObject(value);
	if (!source) return null;
	const out: MonthlyCosts = {
		rent: asNumber(source.rent, 0, 100_000),
		funduszRemontowy: asNumber(source.funduszRemontowy, 0, 10_000),
		mediaIncluded: asBoolean(source.mediaIncluded),
		advance: asNumber(source.advance, 0, 100_000),
		agencyFeePct: asNumber(source.agencyFeePct, 0, 10),
	};
	return Object.values(out).some((entry) => entry != null) ? out : null;
}

function factContext(value: unknown): FactContext | null {
	return booleanRecord(value, [
		"lake",
		"river",
		"forest",
		"mountains",
		"view",
	]) as FactContext | null;
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
		utilities: booleanRecord(row.utilities, [
			"power",
			"water",
			"gas",
			"sewer",
			"internet",
		]) as PlotUtilities | null,
		roadAccess: asEnum(row.roadAccess, FACT_VALUES.roadAccess),
		roadPublic: asBoolean(row.roadPublic),
		mpzpSymbol: asText(row.mpzpSymbol, 24),
		mpzpPurpose: asEnum(row.mpzpPurpose, FACT_VALUES.mpzpPurpose),
		buildingPermitWz: asBoolean(row.buildingPermitWz),
		plotShape: asEnum(row.plotShape, FACT_VALUES.plotShape),
		plotDimensions: asText(row.plotDimensions, 40),
		plotSlope: asEnum(row.plotSlope, FACT_VALUES.plotSlope),
		fencing: asBoolean(row.fencing),
		kitchen: asEnum(row.kitchen, FACT_VALUES.kitchen),
		exposure: asEnum(row.exposure, FACT_VALUES.exposure),
		windows: asEnum(row.windows, FACT_VALUES.windows),
		technology: asEnum(row.technology, FACT_VALUES.technology),
		insulation: asBoolean(row.insulation),
		floorHeating: asBoolean(row.floorHeating),
		heatPump: asBoolean(row.heatPump),
		recuperation: asBoolean(row.recuperation),
		ac: asBoolean(row.ac),
		pv: asBoolean(row.pv),
		parkingSpots: asCount(row.parkingSpots, 0, 200),
		balconyM2: asNumber(row.balconyM2, 0, 1_000),
		terraceM2: asNumber(row.terraceM2, 0, 1_000),
		gardenM2: asNumber(row.gardenM2, 0, 100_000),
		garageM2: asNumber(row.garageM2, 0, 1_000),
		legalStatus: asEnum(row.legalStatus, FACT_VALUES.legalStatus),
		encumbrances: asStringList(row.encumbrances),
		defects: asStringList(row.defects),
		monthlyCosts: monthlyCosts(row.monthlyCosts),
		context: factContext(row.context),
		tenanted: asBoolean(row.tenanted),
		urgency: asEnum(row.urgency, FACT_VALUES.urgency),
	};
	return facts;
}

function isNestedEmpty(value: unknown): boolean {
	if (value == null) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === "object") {
		return Object.values(value as Record<string, unknown>).every(isNestedEmpty);
	}
	return false;
}

/** Every fact null/empty means the model had nothing to add: not worth storing. */
export function isEmptyFacts(facts: ListingFacts): boolean {
	return Object.values(facts).every(isNestedEmpty);
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
