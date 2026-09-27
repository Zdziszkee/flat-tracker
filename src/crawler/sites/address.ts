/**
 * Address parsing helpers for feeds that carry street names but no
 * coordinates (morizon, gratka, domiporta, nieruchomosci-online).
 *
 * The parser is deliberately strict: ad descriptions are full of boilerplate
 * ("Oferujemy...", "Zapraszam...", "Biuro...") and a loose regex happily
 * emits garbage like "Sztuka, Krowodrza, Kraków" as an address, which then
 * geocodes to a random point. We only accept a street when it is
 * explicitly prefixed (ul./al./os./...) or carries a housenumber, and the
 * words must not be ad-speak.
 */

import { KRAKOW_STREETS } from "../krakow-streets.ts";
import { streetKey } from "../street-key.ts";

const WORD = "[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]";
const REST = "[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż .'-]";
const PREFIX_SRC =
	"(?:ul\\.?|ulica|ulicy|al\\.?|aleja|os\\.?|osiedle|pl\\.?|plac|rynek|bulwar|rondo)";

/** "ul. Jakuba Bojki 12/5" — explicit prefix, number optional. */
const PREFIXED_RE = new RegExp(
	`(?:^|[,\\s(:"'“”„»])(${PREFIX_SRC}\\s+${WORD}${REST}{0,60})\\s*(\\d{1,4}[A-Za-z]?)?(?:\\/\\d+)?(?=[,\\s/)]|$)`,
	"giu",
);

/** "Jakuba Bojki 12" — bare street, housenumber REQUIRED. */
const BARE_RE = new RegExp(
	`(?:^|[,\\s(:"'“”„»])(${WORD}${REST}{1,60})\\s+(\\d{1,4}[A-Za-z]?)(?:\\/\\d+)?(?=[,\\s/)]|$)`,
	"giu",
);

/** Words that never start a street name (ad-speak, real-estate jargon). */
const STOPWORDS = new Set([
	// Phase ordinals ("etap 1" is not a street; Photon matches it to
	// Oświęcim's "Ostatni Etap" street and pins Kraków estates there).
	"etap",
	"etapie",
	"etapu",
	"etapem",
	"etapy",
	"etapow",
	"etapom",
	"etapowy",
	"etapowe",
	"etapowa",
	"etapowej",
	"etapowego",
	"mieszkanie",
	"mieszkania",
	"mieszkaniowe",
	"mieszkaniowy",
	"sprzedaz",
	"sprzedam",
	"sprzedaje",
	"sprzedajemy",
	"sprzedazy",
	"oferta",
	"oferty",
	"ofert",
	"oferujemy",
	"oferuje",
	"oferujemy",
	"zapraszam",
	"zapraszamy",
	"biuro",
	"zakup",
	"kupno",
	"kupie",
	"kupimy",
	"pokoje",
	"pokoj",
	"pokojowe",
	"pokojowa",
	"pokoik",
	"kawalerka",
	"kawalerki",
	"apartament",
	"apartamenty",
	"dom",
	"domy",
	"pietro",
	"pietra",
	"budynek",
	"budynki",
	"lokal",
	"lokale",
	"klatka",
	"kondygnacja",
	"cena",
	"powierzchnia",
	"parking",
	"szukam",
	"szukamy",
	"start",
	"krakow",
	"krakowie",
	"nowoczesne",
	"nowoczesna",
	"komfortowe",
	"komfortowa",
	"atrakcyjne",
	"atrakcyjna",
	"piekne",
	"piekna",
	"swietne",
	"swietna",
	"idealne",
	"idealna",
	"dobre",
	"dobra",
	"duze",
	"duza",
	"male",
	"mala",
	"tanie",
	"tania",
	"drogie",
	"droga",
	"wysokie",
	"wysoka",
	"niskie",
	"niska",
	"wygodne",
	"wygodna",
	"przestronne",
	"przestronna",
	"serdecznie",
	"witam",
	"kontaktu",
	"telefonu",
	"zainteresowanych",
	"szczegolami",
	"bezposrednio",
	"polecam",
	"inwestycja",
	"zl",
	"zł",
	"zlotych",
	"tys",
	"tysiecy",
	"osob",
	"osoby",
	"piwnica",
	"balkon",
	"taras",
	"ogrod",
	"garaz",
	"winda",
	"sztuka",
	"sztuki",
	"nabor",
	"inwestor",
	"deweloper",
	"dewelopera",
	"standard",
	"wykonczenie",
	"ul",
	"al",
	"os",
	"pl",
	"ulica",
	"ulicy",
	"aleja",
	"osiedle",
	"plac",
	"rynek",
	"bulwar",
	"rondo",
	"sw",
	"ks",
	"gen",
	"prof",
	"dr",
	"mgr",
	"nr",
	// Court-notice / ad-description boilerplate that leaks past the bare
	// street regex ("o pow. 1,1600ha", "położone na 1 piętrze",
	// "dwóch sypialni oraz łazienki o łącznej powierzchni użytkowej 48").
	"pow",
	"położone",
	"położona",
	"położony",
	"położeniu",
	"położonej",
	"łącznej",
	"lacznej",
	"użytkowej",
	"uzytkowej",
	"powierzchni",
	"sypialni",
	"sypialniach",
	"łazienki",
	"lazienki",
	"dwóch",
	"dwoch",
	"trzech",
	"czterech",
	"m2",
	"m²",
	"ha",
	"english",
	"version",
	"below",
]);

/** Short function words allowed inside a street name ("ul. Na Błoniach"). */
const FUNCTION_WORDS = new Set([
	"na",
	"w",
	"z",
	"do",
	"od",
	"po",
	"przy",
	"pod",
	"nad",
	"i",
	"oraz",
	"u",
	"o",
	"a",
	"im",
	"dla",
	"bez",
	"między",
	"miedzy",
	"ku",
]);

function stripPrefix(street: string): string {
	return street
		.replace(
			/^(?:ul\.?|ulica|ulicy|al\.?|aleja|os\.?|osiedle|pl\.?|plac|rynek|bulwar|rondo)\s+/iu,
			"",
		)
		.trim();
}

/**
 * Description markers that terminate a street name. The bare regex otherwise
 * keeps reading into the body ("ul. Truszkowskiego english version below",
 * "Mackiewicza 4-pokojowe mieszkanie"), so cut at the first marker.
 */
const STREET_END_MARKERS =
	/\s+(english|wersja|opis|opisana|mamy|przyjemnosc|przyjemność|zapraszam|zapraszamy|oferujemy|oferuje|polecam|polecamy|biuro|kontakt|tel|numer|ksiega|pietro|pietra|kondygnacja|m2|m²|powstała|powstały|powstało|powstaje|powstają|powstanie|budowa|budowie|budowany|budowana|budowane|realizowana|realizowany|realizowane|znajduje|znajdują|zlokalizowana|zlokalizowany|zlokalizowane|inwestycja|inwestycji|inwestycję|budynek|budynku|blok|bloku|dom|domy|domów|domków|segmenty|segmentów|osiedle)\b.*$/iu;

function truncateStreet(street: string): string {
	return street.replace(STREET_END_MARKERS, "").trim();
}

function validStreet(street: string): boolean {
	if (street.length < 3) return false;
	const words = street.toLowerCase().split(/\s+/);
	// Real Polish street names are short (1-4 words). Longer runs are
	// description boilerplate ("dwóch sypialni oraz łazienki o łącznej
	// powierzchni użytkowej") that the bare regex otherwise accepts.
	if (words.length > 4) return false;
	return words.every((w) => {
		// Normalize diacritics before the stopword check: the lexicon is
		// ASCII-only ("krakow", "male"), and an un-normalized "Kraków" /
		// "Małe" slips past it, letting "Kołłątajówka Kraków od Spravia"
		// pass as a street name.
		const clean = w
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/\.$/, ""); // "ul." -> "ul"
		if (FUNCTION_WORDS.has(clean)) return true;
		return !STOPWORDS.has(clean);
	});
}

/** Polish adjectival/name declension suffixes, longest first (normalized). */
const DECLENSION_SUFFIXES = [
	"iego",
	"iemu",
	"ymi",
	"imi",
	"ych",
	"ich",
	"ego",
	"emu",
	"iej",
	"ej",
	"ym",
	"im",
	"ie",
	"a",
	"e",
	"y",
	"i",
];

/** Canonical Krakow street names, keyed by `streetKey`. */
const STREET_KEYS = new Map<string, string>();
/** Declension stem -> canonical names sharing that stem. */
const STREET_STEMS = new Map<string, string[]>();

/** Strip a known declension suffix, returning the stem, or null. */
function adjectivalStem(key: string): string | null {
	for (const suffix of DECLENSION_SUFFIXES) {
		if (key.endsWith(suffix) && key.length - suffix.length >= 3) {
			return key.slice(0, -suffix.length);
		}
	}
	return null;
}

for (const name of KRAKOW_STREETS) {
	const key = streetKey(name);
	STREET_KEYS.set(key, name);
	const stem = adjectivalStem(key) ?? key;
	const list = STREET_STEMS.get(stem) ?? [];
	list.push(name);
	STREET_STEMS.set(stem, list);
}

/** True if `street` is a canonical Krakow street name from the lexicon. */
export function isKnownKrakowStreet(street: string): boolean {
	const key = streetKey(street);
	return key ? STREET_KEYS.has(key) : false;
}

/**
 * Map a parsed street name to its canonical Krakow form by matching the
 * declension stem against the lexicon, so any case form resolves to the
 * official name: "Karmelickiej"/"Karmelicką"/"Karmelickiego" -> "Karmelicka",
 * "Arciszewski" -> "Arciszewskiego". Falls back to the input when no
 * canonical match is found, so the caller can still try Nominatim.
 */
export function resolveStreetName(street: string): string {
	const key = streetKey(street);
	if (!key) return street;
	const exact = STREET_KEYS.get(key);
	if (exact) return exact;
	const stem = adjectivalStem(key) ?? key;
	const candidates = STREET_STEMS.get(stem);
	if (!candidates || candidates.length === 0) return street;
	// Prefer the feminine nominative form (canonical for most adjective
	// streets); otherwise take the first lexicon match.
	return candidates.find((c) => streetKey(c).endsWith("a")) ?? candidates[0];
}

/** Extract "Street 12" from free text like "ul. Jakuba Bojki 12/5, Kraków". */
export function parseAddressFromText(
	text: string | null | undefined,
): { street: string; number?: string } | null {
	if (!text) return null;
	const t = text.replace(/\s+/g, " ").trim();

	const candidates: Array<{
		index: number;
		street: string;
		number?: string;
		prefixed: boolean;
	}> = [];
	for (const m of t.matchAll(PREFIXED_RE)) {
		candidates.push({
			index: m.index ?? 0,
			street: m[1],
			number: m[2],
			prefixed: true,
		});
	}
	for (const m of t.matchAll(BARE_RE)) {
		candidates.push({
			index: m.index ?? 0,
			street: m[1],
			number: m[2],
			prefixed: false,
		});
	}
	// Prefer explicitly-prefixed streets (ul./al./os.) over bare "Word Number"
	// matches, which are far more likely to be boilerplate ("pow. 1,1600ha",
	// "powierzchni użytkowej 48").
	candidates.sort(
		(a, b) => Number(b.prefixed) - Number(a.prefixed) || a.index - b.index,
	);

	let fallback: { street: string; number?: string } | null = null;
	for (const c of candidates) {
		const street = truncateStreet(
			stripPrefix(c.street).replace(/\s+/g, " ").trim(),
		);
		// The greedy name run can over-capture into prose the end markers
		// missed ("ul. Dobrego Pasterza z widokiem na Wisłę"): try the run
		// and its word prefixes longest-first, so the full name wins when it
		// is the known street and a known-street prefix beats junk prose.
		const words = street.split(/\s+/).filter(Boolean);
		const variants = words
			.map((_, i) => words.slice(0, words.length - i).join(" "))
			// A truncated one-word prefix is a declension trap ("Dobrego" ->
			// "Dobra"): only the full run may be a single word.
			.filter((v, i) => validStreet(v) && (i === 0 || words.length - i >= 2))
			.slice(0, 4);
		for (const variant of variants) {
			const out = {
				street: resolveStreetName(variant),
				number: c.number ?? undefined,
			};
			// Prefer a street we can map to the Krakow lexicon over ad-speak
			// that merely looks address-like ("... w budynku z 2014 ...").
			if (isKnownKrakowStreet(out.street)) return out;
			fallback ??= out;
		}
	}
	return fallback;
}

/** True if the string plausibly names a street (housenumber or prefix). */
export function plausibleAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	if (/\d/.test(address)) return true;
	return new RegExp(`(?:^|[,\\s])${PREFIX_SRC}\\s+${WORD}`, "giu").test(
		address,
	);
}

/** A free-text-mined street must LOOK like a street name: a capitalized
 * (or house-numbered) name of at most 3 words, no sentence punctuation,
 * no prose opener ("a kończą na", "informacyjna inwestycji", "Przejrzano
 * 2092"). Without this gate, mining returns sentence fragments that then
 * pin to unrelated streets. */
export function minedStreetLooksReal(
	street: string | null | undefined,
): boolean {
	if (!street) return false;
	const head = street
		.replace(/^(?:przy\s+ulicy|przy\s+ul\.?|ulica|ul\.|przy|od|na|w)\s+/iu, "")
		.trim();
	if (head.length < 3 || /[.;:!?]/u.test(head)) return false;
	// A spaced hyphen joins a prose tail ("Sołtysowskiej - Willa
	// Sołtysowska"); this gate never rewrites the street, so reject —
	// callers that can cut run their own sanitize first.
	if (/\s+[-–—]\s+/u.test(head)) return false;
	const words = head.split(/\s+/u).filter((w) => /\p{L}/u.test(w));
	if (words.length > 3) return false;
	if (!/^[\p{Lu}\p{N}]/u.test(head)) return false;
	return !/^(?:przejrzano|odsłon|wyświetlono|szukano|informacyjna|strona|planie|razie|reszta|minut|koszt|cena|ceny|mieszkań|mieszkania|budowy|budynku|budynków|szkoły|drzwi|kończą|powstało|powstać|zbudowali|licząc\w*|mająca|mający|mające|większe|największe|zaczynają|kierowano)\b/iu.test(
		head,
	);
}

/** Build a geocodable address string, e.g. "Jakuba Bojki 12, Kraków". */
export function formatAddressForGeocode(
	street: string,
	number?: string,
	district?: string | null,
	city: string | null = "Kraków",
): string {
	const streetPart = number ? `${street} ${number}` : street;
	return [streetPart, district, city].filter(Boolean).join(", ");
}
