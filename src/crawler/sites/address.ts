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

function validStreet(street: string): boolean {
	if (street.length < 3) return false;
	const words = street.toLowerCase().split(/\s+/);
	return words.every((w) => {
		const clean = w.replace(/\.$/, ""); // "ul." -> "ul"
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
function resolveStreetName(street: string): string {
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

	const candidates: Array<{ index: number; street: string; number?: string }> =
		[];
	for (const m of t.matchAll(PREFIXED_RE)) {
		candidates.push({ index: m.index ?? 0, street: m[1], number: m[2] });
	}
	for (const m of t.matchAll(BARE_RE)) {
		candidates.push({ index: m.index ?? 0, street: m[1], number: m[2] });
	}
	candidates.sort((a, b) => a.index - b.index);

	let fallback: { street: string; number?: string } | null = null;
	for (const c of candidates) {
		const street = stripPrefix(c.street).replace(/\s+/g, " ").trim();
		if (!validStreet(street)) continue;
		const out = {
			street: resolveStreetName(street),
			number: c.number ?? undefined,
		};
		// Prefer a street we can map to the Krakow lexicon over ad-speak that
		// merely looks address-like ("... w budynku z 2014 ...").
		if (isKnownKrakowStreet(out.street)) return out;
		fallback ??= out;
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

/** Build a geocodable address string, e.g. "Jakuba Bojki 12, Kraków". */
export function formatAddressForGeocode(
	street: string,
	number?: string,
	district?: string | null,
): string {
	const streetPart = number ? `${street} ${number}` : street;
	return [streetPart, district, "Kraków"].filter(Boolean).join(", ");
}
