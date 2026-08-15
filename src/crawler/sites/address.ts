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

/** Canonical Krakow street names, keyed by `streetKey`. */
const STREET_KEYS = new Map<string, string>();
for (const name of KRAKOW_STREETS) {
	STREET_KEYS.set(streetKey(name), name);
}

/**
 * Map a parsed street name to its canonical Krakow form. Handles the common
 * feminine-adjective declensions seen in ad descriptions:
 * "Karmelickiej"/"Długiej" -> "Karmelicka"/"Długa". Returns the input when
 * no canonical match is found, so the caller can still try Nominatim.
 */
function resolveStreetName(street: string): string {
	const key = streetKey(street);
	if (!key) return street;
	const exact = STREET_KEYS.get(key);
	if (exact) return exact;
	const tries: string[] = [];
	if (key.endsWith("iej")) tries.push(`${key.slice(0, -3)}a`);
	else if (key.endsWith("ej")) tries.push(`${key.slice(0, -2)}a`);
	for (const candidate of tries) {
		const hit = STREET_KEYS.get(candidate);
		if (hit) return hit;
	}
	return street;
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

	for (const c of candidates) {
		const street = stripPrefix(c.street).replace(/\s+/g, " ").trim();
		if (!validStreet(street)) continue;
		return { street: resolveStreetName(street), number: c.number ?? undefined };
	}
	return null;
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
