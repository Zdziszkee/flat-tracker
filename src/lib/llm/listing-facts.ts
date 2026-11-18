/**
 * Listing facts extracted from the title and description by a model.
 *
 * The portals leave most physical facts out of their structured fields (the
 * bulk feeds publish no heating, no building style, no condition), yet
 * sellers state them in prose. A regular expression catches the obvious
 * "ogrzewanie miejskie" and nothing else, so a model reads the text and
 * returns the small enum set the scoring layer already understands. Prompt
 * v2 widens the schema to what a 120-offer probe measured as present and
 * useful: plot utilities and access, defects, legal status, exact monthly
 * costs, kitchen/exposure/windows, building technology and the setting
 * around a plot or house.
 *
 * Everything here is pure: prompt construction, response parsing and
 * normalization. Writing to the database lives in `extract.ts`, reading it
 * back in `fact-access.ts`, so this module stays testable without a network
 * or a DB (`validate:facts`).
 *
 * The model is a data source, not a trusted one: unknown ids are dropped,
 * values outside the allowed sets become null, numbers outside a plausible
 * range become null, free text and code lists are bounded, and a fact the
 * text does not state must be "unknown"/null rather than a guess.
 */

/** The enum vocabulary, one entry per enum-shaped fact. */
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
	/** Who owns the road that reaches the plot. */
	roadAccess: ["public", "private", "none", "unknown"],
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
	plotShape: ["regular", "irregular", "narrow", "unknown"],
	plotSlope: ["flat", "gentle", "steep", "unknown"],
	/** Kitchen layout: a separate room, an annex, or open to the living room. */
	kitchen: ["open", "separate", "annex", "unknown"],
	/** Window state: replaced, original, or a mix. */
	windows: ["new", "old", "mixed", "unknown"],
	technology: ["traditional", "prefab", "framed", "unknown"],
	/** Mortgage-ability of the title, independent of the ownership enum. */
	legalStatus: ["own", "cooperative", "perpetual_usufruct", "share", "unknown"],
	urgency: ["urgent", "none", "unknown"],
} as const;

export type FactEnumField = keyof typeof FACT_VALUES;

/** Compass points the flat's windows face; an ad may name several. */
export const EXPOSURE_TOKENS = ["N", "S", "E", "W"] as const;

/** Utility connections on a plot. An unstated utility is false, not unknown. */
export interface PlotUtilities {
	power: boolean;
	water: boolean;
	gas: boolean;
	sewer: boolean;
	internet: boolean;
}

/** Monthly costs quoted in the ad, PLN. */
export interface MonthlyCosts {
	/** Czynsz administracyjny. */
	rent: number | null;
	/** Fundusz remontowy. */
	funduszRemontowy: number | null;
	/** Zaliczka na media, when quoted separately. */
	advance: number | null;
	/** Whether media are part of the rent. */
	mediaIncluded: boolean | null;
	/** Agency commission, percent of the price. */
	agencyFeePct: number | null;
}

/** Setting the description claims for a plot or house. */
export interface FactContext {
	lake: boolean;
	river: boolean;
	forest: boolean;
	mountains: boolean;
	/** What the windows look onto ("widok na góry", "na jezioro"). */
	view: string | null;
}

export interface ListingFacts {
	// --- v1 ---------------------------------------------------------------
	heating: string | null;
	buildingType: string | null;
	/** `true` only for a large-panel prefabricated block (wielka płyta). */
	largePanel: boolean | null;
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
	mpzpSymbol: string | null;
	mpzpPurpose: string | null;
	buildingPermitWz: boolean | null;
	plotShape: string | null;
	plotDimensions: string | null;
	plotSlope: string | null;
	fencing: boolean | null;
	kitchen: string | null;
	exposure: string[] | null;
	windows: string | null;
	technology: string | null;
	insulation: boolean | null;
	floorHeating: boolean | null;
	heatPump: boolean | null;
	recuperation: boolean | null;
	airConditioning: boolean | null;
	photovoltaics: boolean | null;
	parkingSpots: number | null;
	balconyM2: number | null;
	terraceM2: number | null;
	gardenM2: number | null;
	garageM2: number | null;
	legalStatus: string | null;
	encumbrances: string[] | null;
	defects: string[] | null;
	context: FactContext | null;
	tenanted: boolean | null;
	urgency: string | null;
	monthlyCosts: MonthlyCosts | null;
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
		"public = droga publiczna, gminna; private = droga prywatna, wewnętrzna, służebność; none = brak dojazdu",
	],
	mpzpPurpose: [
		"MN = residential; MN/U = residential_services; MW = multi_family; U = services; R/RM = agricultural; ZL = forest",
	],
	plotShape: [
		"regular = prostokątna, foremna; irregular = nieregularna, trapez; narrow = wąska, wydłużona",
	],
	plotSlope: [
		"flat = płaska, równa; gentle = lekki spadek; steep = stroma, skarpa",
	],
	kitchen: [
		"separate = oddzielna kuchnia; annex = aneks kuchenny; open = otwarta na salon",
	],
	windows: [
		"new = nowe, wymienione, plastikowe, PVC; old = stare, drewniane, do wymiany; mixed = częściowo wymienione",
	],
	technology: [
		"traditional = murowana, tradycyjna; prefab = prefabrykowana, wielkopłytowa; framed = szkieletowa, drewniana",
	],
	legalStatus: [
		"own = własność, księga wieczysta; cooperative = spółdzielcze własnościowe; perpetual_usufruct = użytkowanie wieczyste; share = udział, współwłasność",
	],
	urgency: [
		"urgent = pilne, szybka sprzedaż, sprzedaż z powodu wyjazdu; none = brak pośpiechu",
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
		"Odpowiadasz WYŁĄCZNIE zwartym obiektem JSON, bez prozy, komentarzy i markdown.",
		"Wypełniaj pole tylko wtedy, gdy wynika ono wprost z tekstu ogłoszenia. Nie zgaduj.",
		"Brak informacji to null (enum/liczba/tekst/lista) albo false (boolean), nie domysł.",
		"Wartość false jest informacją: brak windy, brak mediów, brak dojazdu to false.",
		"Każdy obiekt Wyniku musi mieć WSZYSTKIE klucze ze schematu, także null/false.",
		"",
		"Dozwolone wartości enumów:",
		...Object.keys(FACT_VALUES).map((field) =>
			enumLine(field as FactEnumField),
		),
		"",
		`exposure: tablica podzbioru ["N","S","E","W"] — strony świata, na które wychodzą okna ("okna na południe" = ["S"], "wschód-zachód" = ["E","W"]). Brak informacji = null.`,
		"",
		"Liczby: buildYear (1800-2035), plotAreaM2 (m2 działki), floor (0 = parter, -1 = piwnica/suterena), floorCount (pięter w budynku),",
		"parkingSpots (0-50), balconyM2, terraceM2, gardenM2, garageM2 (m2, 0-5000).",
		"Booleany (true/false): hasBalcony, hasTerrace, hasGarden, hasElevator, hasParking, hasGarage, hasBasement, buildingPermitWz (decyzja WZ),",
		"largePanel (true TYLKO dla wielkiej płyty / prefabrykatu z lat 60-80; zwykły blok murowany = false),",
		"fencing, insulation, floorHeating, heatPump, recuperation, airConditioning, photovoltaics, tenanted.",
		"Tekst: mpzpSymbol (np. MN, MN/U, MW, U, R, ZL), plotDimensions (np. 20x40 m).",
		"",
		"Pola złożone:",
		'utilities: {"power":bool,"water":bool,"gas":bool,"sewer":bool,"internet":bool} — tylko dla DZIAŁKI lub domu z działką; przyłącza NA DZIAŁCE, "media do doprowadzenia" = false, "wszystkie media" = true; dla mieszkania utilities = null.',
		'monthlyCosts: {"rent":liczba,"funduszRemontowy":liczba,"advance":liczba,"mediaIncluded":bool,"agencyFeePct":liczba} — zł/mies., prowizja w % (0-10).',
		'context: {"lake":bool,"river":bool,"forest":bool,"mountains":bool,"view":tekst} — otoczenie i widok z opisu ("nad jeziorem", "obok lasu", "widok na góry").',
		'defects: krótkie kody wad i ryzyk, np. "damp", "no_lift", "roof_to_renovation", "media_missing", "no_access", "flood_risk", "noise", "tenanted".',
		'encumbrances: krótkie kody obciążeń prawnych, np. "mortgage", "easement", "claims", "life_estate".',
		'urgency: pilna sprzedaż; "none" gdy ogłoszenie nie sugeruje pośpiechu.',
		"",
		'Schemat odpowiedzi: {"results":[{"id":0,"heating":null,"buildingType":null,"largePanel":null,"plotType":null,"buildingMaterial":null,"condition":null,"ownership":null,"buildYear":null,"plotAreaM2":null,"floor":null,"floorCount":null,"hasBalcony":null,"hasTerrace":null,"hasGarden":null,"hasElevator":null,"hasParking":null,"hasGarage":null,"hasBasement":null,"utilities":null,"roadAccess":null,"mpzpSymbol":null,"mpzpPurpose":null,"buildingPermitWz":null,"plotShape":null,"plotDimensions":null,"plotSlope":null,"fencing":null,"kitchen":null,"exposure":null,"windows":null,"technology":null,"insulation":null,"floorHeating":null,"heatPump":null,"recuperation":null,"airConditioning":null,"photovoltaics":null,"parkingSpots":null,"balconyM2":null,"terraceM2":null,"gardenM2":null,"garageM2":null,"legalStatus":null,"encumbrances":null,"defects":null,"context":null,"tenanted":null,"urgency":null,"monthlyCosts":null}]}',
		"",
		'Jeden obiekt na ogłoszenie, w tej samej kolejności, każdy z polem "id".',
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
	"sieć miejska": "district",
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
	wielkopłytowa: "block",
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
	// ("użytkowanie wieczyste" maps to legalStatus.perpetual_usufruct; the
	// ownership enum takes the model's own leasehold answer.)
	udział: "share",
	współwłasność: "share",
	// road access
	publiczna: "public",
	"droga publiczna": "public",
	gminna: "public",
	prywatna: "private",
	"droga prywatna": "private",
	wewnętrzna: "private",
	służebność: "private",
	"brak dojazdu": "none",
	brak: "none",
	// mpzp purpose
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
	// plot shape
	prostokątna: "regular",
	foremna: "regular",
	nieregularna: "irregular",
	trapez: "irregular",
	wydłużona: "narrow",
	wąska: "narrow",
	// slope
	płaska: "flat",
	równa: "flat",
	"lekki spadek": "gentle",
	stroma: "steep",
	skarpa: "steep",
	// kitchen
	oddzielna: "separate",
	aneks: "annex",
	"aneks kuchenny": "annex",
	otwarta: "open",
	"otwarta kuchnia": "open",
	// windows
	nowe_okna: "new",
	"nowe okna": "new",
	wymienione: "new",
	plastikowe: "new",
	pvc: "new",
	stare: "old",
	drewniane: "old",
	"do wymiany": "old",
	"częściowo wymienione": "mixed",
	// technology
	murowana: "traditional",
	tradycyjna: "traditional",
	szkieletowa: "framed",
	prefabrykowana: "prefab",
	drewniana: "framed",
	// legal status
	księga: "own",
	"ksiega wieczysta": "own",
	"księga wieczysta": "own",
	kw: "own",
	własnościowe: "cooperative",
	"spółdzielcze własnościowe": "cooperative",
	"spoldzielcze wlasnosciowe": "cooperative",
	"użytkowanie wieczyste": "perpetual_usufruct",
	"udział w gruncie": "share",
	// urgency
	pilne: "urgent",
	"pilna sprzedaż": "urgent",
	"szybka sprzedaż": "urgent",
	// exposure words (mapped by the array parser, kept for completeness)
	południe: "S",
	północ: "N",
	wschód: "E",
	zachód: "W",
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
const MAX_CODE_CHARS = 40;

/** Lowercase ASCII slug, so a "code" list stays a list of short codes. */
function asCode(value: unknown): string | null {
	const text = asText(value, 120);
	if (!text) return null;
	const code = text
		.replace(/[łŁ]/gu, "l")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.slice(0, MAX_CODE_CHARS);
	return code || null;
}

function asCodeList(value: unknown): string[] | null {
	const source = Array.isArray(value)
		? value
		: typeof value === "string"
			? [value]
			: [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of source) {
		const code = asCode(entry);
		if (!code || seen.has(code)) continue;
		seen.add(code);
		out.push(code);
		if (out.length >= MAX_LIST_ITEMS) break;
	}
	return out.length > 0 ? out : null;
}

/** Exposure is a subset of N/S/E/W; anything else in the answer is ignored. */
export function asExposure(value: unknown): string[] | null {
	const source = Array.isArray(value)
		? value
		: typeof value === "string"
			? [value]
			: [];
	const out: string[] = [];
	for (const entry of source) {
		if (typeof entry !== "string") continue;
		const text = entry.trim().toLowerCase();
		if (!text) continue;
		const found = new Set<string>();
		// A single entry may name both sides ("wschód-zachód").
		for (const [words, point] of COMPASS_WORDS) {
			if (words.some((word) => text.includes(word))) found.add(point);
		}
		if (found.size === 0) {
			const upper = text.toUpperCase();
			if ((EXPOSURE_TOKENS as readonly string[]).includes(upper)) {
				found.add(upper);
			} else if (/^[NSEW]+$/u.test(upper)) {
				// Compact answers like "NS" or "EW".
				for (const letter of upper) {
					if ((EXPOSURE_TOKENS as readonly string[]).includes(letter)) {
						found.add(letter);
					}
				}
			}
		}
		for (const point of found) if (!out.includes(point)) out.push(point);
	}
	const order = EXPOSURE_TOKENS as readonly string[];
	out.sort((a, b) => order.indexOf(a) - order.indexOf(b));
	return out.length > 0 ? out : null;
}

/** Polish/English compass words in an exposure entry. */
const COMPASS_WORDS: ReadonlyArray<readonly [readonly string[], string]> = [
	[["południe", "południow", "south"], "S"],
	[["północ", "północn", "north"], "N"],
	[["wschód", "wschodni", "east"], "E"],
	[["zachód", "zachodni", "west"], "W"],
];

/** Utilities keep a plain boolean per key: unstated means not connected. */
function plotUtilities(value: unknown): PlotUtilities | null {
	const source = asObject(value);
	if (!source) return null;
	const keys = ["power", "water", "gas", "sewer", "internet"] as const;
	if (!keys.some((key) => asBoolean(source[key]) != null)) return null;
	const out = {} as PlotUtilities;
	for (const key of keys) out[key] = asBoolean(source[key]) ?? false;
	return out;
}

function monthlyCosts(value: unknown): MonthlyCosts | null {
	const source = asObject(value);
	if (!source) return null;
	const out: MonthlyCosts = {
		rent: asNumber(source.rent, 0, 20_000),
		funduszRemontowy: asNumber(source.funduszRemontowy, 0, 5_000),
		advance: asNumber(source.advance, 0, 20_000),
		mediaIncluded: asBoolean(source.mediaIncluded),
		agencyFeePct: asNumber(source.agencyFeePct, 0, 10),
	};
	return Object.values(out).some((entry) => entry != null) ? out : null;
}

function factContext(value: unknown): FactContext | null {
	const source = asObject(value);
	if (!source) return null;
	const out: FactContext = {
		lake: asBoolean(source.lake) ?? false,
		river: asBoolean(source.river) ?? false,
		forest: asBoolean(source.forest) ?? false,
		mountains: asBoolean(source.mountains) ?? false,
		view: asText(source.view, 60),
	};
	const anyFlag = out.lake || out.river || out.forest || out.mountains;
	return anyFlag || out.view ? out : null;
}

/**
 * One record from the model answer, or null when the row is unusable (not an
 * object). Range checks are wide on purpose: they catch a swapped field
 * ("2024" poked into floorCount), not a judgement call.
 */
export function normalizeFacts(raw: unknown): ListingFacts | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const row = raw as Record<string, unknown>;
	const facts: ListingFacts = {
		heating: asEnum(row.heating, FACT_VALUES.heating),
		buildingType: asEnum(row.buildingType, FACT_VALUES.buildingType),
		largePanel: asBoolean(row.largePanel),
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
		utilities: plotUtilities(row.utilities),
		roadAccess: asEnum(row.roadAccess, FACT_VALUES.roadAccess),
		mpzpSymbol: asText(row.mpzpSymbol, 24),
		mpzpPurpose: asEnum(row.mpzpPurpose, FACT_VALUES.mpzpPurpose),
		buildingPermitWz: asBoolean(row.buildingPermitWz),
		plotShape: asEnum(row.plotShape, FACT_VALUES.plotShape),
		plotDimensions: asText(row.plotDimensions, 40),
		plotSlope: asEnum(row.plotSlope, FACT_VALUES.plotSlope),
		fencing: asBoolean(row.fencing),
		kitchen: asEnum(row.kitchen, FACT_VALUES.kitchen),
		exposure: asExposure(row.exposure),
		windows: asEnum(row.windows, FACT_VALUES.windows),
		technology: asEnum(row.technology, FACT_VALUES.technology),
		insulation: asBoolean(row.insulation),
		floorHeating: asBoolean(row.floorHeating),
		heatPump: asBoolean(row.heatPump),
		recuperation: asBoolean(row.recuperation),
		airConditioning: asBoolean(row.airConditioning),
		photovoltaics: asBoolean(row.photovoltaics),
		parkingSpots: asCount(row.parkingSpots, 0, 50),
		balconyM2: asNumber(row.balconyM2, 0, 5_000),
		terraceM2: asNumber(row.terraceM2, 0, 5_000),
		gardenM2: asNumber(row.gardenM2, 0, 5_000),
		garageM2: asNumber(row.garageM2, 0, 5_000),
		legalStatus: asEnum(row.legalStatus, FACT_VALUES.legalStatus),
		encumbrances: asCodeList(row.encumbrances),
		defects: asCodeList(row.defects),
		context: factContext(row.context),
		tenanted: asBoolean(row.tenanted),
		urgency: asEnum(row.urgency, FACT_VALUES.urgency),
		monthlyCosts: monthlyCosts(row.monthlyCosts),
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
