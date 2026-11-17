/**
 * Fixtures-only regression checks for address mining and court-notice
 * stripping. No database queries and no network: every case is a pinned
 * string, so the harness runs on an empty clone.
 *
 * Run:
 *
 *   bun run validate:geocode
 */

import { propertyPartOf } from "../src/crawler/geocode-listings.ts";
import {
	minedStreetLooksReal,
	parseAddressFromText,
	plausibleAddress,
} from "../src/crawler/sites/address.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// ---------- (1) court-boilerplate cut ----------
const edge: Array<[string, boolean, string]> = [
	// [title, should cut, expected property part contains]
	["działka dla dziecka 3 pokoje Kraków", false, "dla dziecka"],
	["mieszkanie w Krakowie 45 m2", false, "w Krakowie"],
	["nieruchomość przy ul. Szkolnej dla której SR w Krakowie KW nr 1", true, "Szkolnej"],
	["Lokal, komornik sprzedaje", true, "Lokal"],
	["z siedzibą w Krzeszowicach prowadzi", true, ""],
	["ul. Zamkowa 5, wydział IV ksiąg wieczystych", true, "Zamkowa 5"],
	["dom jednorodzinny nr kw 12/2", true, "dom jednorodzinny"],
	["", false, ""],
];
for (const [t, shouldCut, expect] of edge) {
	const cut = propertyPartOf(t);
	const didCut = cut !== t.replace(/\s+/g, " ").trim();
	check(
		`edge: ${JSON.stringify(t.slice(0, 40))}`,
		didCut === shouldCut && cut.includes(expect),
		`cut=${JSON.stringify(cut)}`,
	);
}
check("edge: null title", propertyPartOf(null) === "");
check(
	"edge: 'dla której' with no court word still cuts",
	propertyPartOf("ul. Szkolna 3 dla której sprzedający gwarantuje").includes(
		"ul. Szkolna 3",
	),
);

// ---------- (2) mined-street shape gate ----------
for (const bad of [
	"a kończą na",
	"informacyjna inwestycji Dobrego Pasterza",
	"Przejrzano 2092",
	"Kondygnacje. W budynku znajdzie się",
	"to z pewnością Grzegórzecka",
	"mieszkań liczących sobie ponad 70",
	"Sołtysowskiej - Willa Sołtysowska. Łącznie",
])
	check(
		`shape: rejects ${JSON.stringify(bad.slice(0, 32))}`,
		!minedStreetLooksReal(bad),
	);
for (const good of [
	"Zamoyskiego",
	"Konstantego Brandla",
	"Na Lotnisku",
	"Bora-Komorowskiego",
	"Piasta Kołodzieja",
	"1 Maja",
])
	check(`shape: accepts ${JSON.stringify(good)}`, minedStreetLooksReal(good));

// ---------- (3) legal boilerplate vs real streets ----------
for (const legal of [
	"prawo użytkowania wieczystego działki nr 41/6",
	"z własnością lokalu zwiazane jest prawo wieczystego uzytkowania gruntu",
	"nieruchomość gruntowa położona w Parkoszowicach",
])
	check(
		`parse: rejects legal boilerplate ${JSON.stringify(legal.slice(0, 36))}`,
		parseAddressFromText(legal) === null,
	);
for (const street of ["Gruntowa", "Działkowa", "Prawa"])
	check(
		`parse: keeps real street ${JSON.stringify(street)}`,
		parseAddressFromText(`ul. ${street} 5`)?.street === street,
	);

// ---------- (4) komornik notices: the court never becomes the address ----------
/**
 * Realistic court-auction titles. The property description comes first; the
 * court name, its seat and the land-register id follow and must never be
 * mined as the property's street or town.
 */
const courtTitles: Array<[string, string | null, string | null]> = [
	// [title, expected street, expected number]
	[
		"nieruchomość przy ul. Szkolnej 5 dla której SR dla Krakowa-Krowodrzy w Krakowie prowadzi KW nr 1",
		"Szkolna",
		"5",
	],
	[
		"lokal mieszkalny nr 3 przy ul. Zamkowej 12, wydział IV ksiąg wieczystych SR w Krakowie",
		"Zamkowa",
		"12",
	],
	[
		"prawo użytkowania wieczystego działki nr 41/6 położonej w Krakowie przy ul. Prawa 5",
		"Prawa",
		"5",
	],
	// Only a plot number and a village, no street: nothing may be mined.
	["działka nr 123/4 w miejscowości Nawojowa Góra, gmina Krzeszowice", null, null],
];

const courtWords =
	/sąd|\bsr\b|wydział|ksi[ąa]g|wieczyst|siedzib|komornik|kw nr|dla któr|\bkraków\b|\bkrakow(?:a|ie|u|em)?\b/iu;

let mined = 0;
let leaks = 0;
for (const [title, expectedStreet, expectedNumber] of courtTitles) {
	const scope = propertyPartOf(title);
	const parsed = parseAddressFromText(scope);
	if (parsed) {
		mined++;
		if (courtWords.test(parsed.street)) leaks++;
		check(
			`komornik: plausible address ${JSON.stringify(title.slice(0, 34))}`,
			plausibleAddress(scope),
			`street=${JSON.stringify(parsed.street)}`,
		);
	}
	check(
		`komornik: mines the property street ${JSON.stringify(title.slice(0, 34))}`,
		(parsed?.street ?? null) === expectedStreet &&
			(parsed?.number ?? null) === expectedNumber,
		`got ${JSON.stringify(parsed)}`,
	);
}
check("komornik: fixtures mine at least one address", mined > 0, `mined=${mined}`);
check("komornik: court words never leak into a mined street", leaks === 0, `leaks=${leaks}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
