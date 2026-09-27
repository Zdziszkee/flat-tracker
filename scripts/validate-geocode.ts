/** Throwaway deep-validation harness for the court-boilerplate geocode fix. */
import Database from "better-sqlite3";

import {
	parseAddressFromText,
	plausibleAddress,
} from "../src/crawler/sites/address.ts";
import { normStreet } from "../src/crawler/address-index.ts";
import { propertyPartOf } from "../src/crawler/geocode-listings.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// ---------- (7) regex edge cases ----------
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

// ---------- corpus over the live DB ----------
const db = new Database("dev.db", { readonly: true });
const rows = db
	.prepare(
		`SELECT id, title, address, district, lat, lng, building_id FROM listings WHERE source = 'licytacje-komornik'`,
	)
	.all() as Array<{
	id: number;
	title: string;
	address: string | null;
	district: string | null;
	lat: number | null;
	lng: number | null;
	building_id: number | null;
}>;

const courtWords =
	/sąd|sr\b|wydział|ksi[ąa]g|wieczyst|siedzib|krakow|komornik|kw nr|dla któr/iu;

// ---------- (8) mining over all titles ----------
let mined = 0;
let leaks = 0;
let plausibleOk = 0;
for (const r of rows) {
	const scope = propertyPartOf(r.title);
	const parsed = parseAddressFromText(scope);
	if (parsed) {
		mined++;
		if (courtWords.test(parsed.street)) {
			leaks++;
			console.log(`  LEAK id=${r.id} street=${JSON.stringify(parsed.street)}`);
		}
		if (plausibleAddress(scope)) plausibleOk++;
	}
}
check("corpus: court words never leak into mined street", leaks === 0, `leaks=${leaks}`);
check(
	"corpus: every minable title passes the plausibleAddress gate",
	plausibleOk === mined,
	`mined=${mined} plausible=${plausibleOk}`,
);

// ---------- (9) pin-vs-town sweep + anchor cross-check ----------
const towns = db
	.prepare(
		`SELECT lower(coalesce(json_extract(tags,'$.addr:city'), json_extract(tags,'$.addr:place'))) town,
		        avg(centroidLat) lat, avg(centroidLng) lng, count(*) n
		 FROM osm_buildings WHERE tags IS NOT NULL GROUP BY town`,
	)
	.all() as Array<{ town: string; lat: number; lng: number; n: number }>;
const townIdx = new Map(
	towns.filter((t) => t.town).map((t) => [normStreet(t.town), t]),
);

function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
	const R = 6371;
	const dLat = ((bLat - aLat) * Math.PI) / 180;
	const dLng = ((bLng - aLng) * Math.PI) / 180;
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((aLat * Math.PI) / 180) *
			Math.cos((bLat * Math.PI) / 180) *
			Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

const allBuildings = db
	.prepare(
		`SELECT centroidLat lat, centroidLng lng, address,
		        lower(coalesce(json_extract(tags,'$.addr:city'), json_extract(tags,'$.addr:place'))) town
		 FROM osm_buildings WHERE tags IS NOT NULL`,
	)
	.all() as Array<{
	lat: number;
	lng: number;
	address: string | null;
	town: string | null;
}>;

let checked = 0;
const far: string[] = [];
for (const r of rows) {
	if (r.lat == null || r.lng == null || !r.district) continue;
	const name = normStreet(r.district);
	const t = townIdx.get(name);
	const sameNamed = allBuildings.filter(
		(b) => b.town && normStreet(b.town) === name,
	);
	if (!t && sameNamed.length === 0) continue; // unverifiable town
	checked++;
	// Twin-town names make the town average meaningless; the pin must sit
	// in ONE of the town's settlements (near a same-name building), or —
	// when no building carries the town tag — near the town average.
	const nearestNamed = Math.min(
		...sameNamed.map((b) => km(r.lat!, r.lng!, b.lat, b.lng)),
		Number.POSITIVE_INFINITY,
	);
	const d = sameNamed.length > 0 ? nearestNamed : km(r.lat, r.lng, t!.lat, t!.lng);
	const limit = sameNamed.length > 0 ? 3 : 15;
	if (d > limit)
		far.push(
			`  FAR id=${r.id} ${d.toFixed(1)}km town=${r.district} addr=${r.address} pin=${r.lat.toFixed(4)},${r.lng.toFixed(4)}`,
		);
}
check(
	"sweep: every located komornik pin sits in its district's settlement",
	far.length === 0,
	`checked=${checked} far=${far.length}`,
);
for (const line of far.slice(0, 10)) console.log(line);

const anchors = db
	.prepare(
		`SELECT l.id, l.district, json_extract(ob.tags,'$.addr:city') bcity,
		 json_extract(ob.tags,'$.addr:street') bstreet
		 FROM listings l JOIN buildings b ON b.id = l.building_id
		 LEFT JOIN osm_buildings ob ON ob.osmId = b.osmId
		 WHERE l.source = 'licytacje-komornik' AND l.building_id IS NOT NULL`,
	)
	.all() as Array<{
	id: number;
	district: string | null;
	bcity: string | null;
	bstreet: string | null;
}>;
// Same place despite naming form: exact fold ("Kraków"), a shared root
// ("Rabce-Zdroju" is the locative of "Rabka-Zdrój"), or the street name
// standing in for the village where OSM tags the gmina as addr:city
// (building "Kroczymiech 11" with addr:city=Chrzanów).
const samePlace = (x: string, y: string): boolean => {
	const a = normStreet(x);
	const b = normStreet(y);
	return (
		a === b ||
		(a.split(/[-\s]/u)[0] ?? "").slice(0, 3) ===
			(b.split(/[-\s]/u)[0] ?? "").slice(0, 3)
	);
};
const anchorBad = anchors.filter(
	(a) =>
		a.bcity &&
		a.district &&
		!samePlace(a.bcity, a.district) &&
		!samePlace(a.bstreet ?? "", a.district),
);
check(
	"anchors: building city matches listing district",
	anchorBad.length === 0,
	`checked=${anchors.length} mismatched=${anchorBad.length}`,
);
for (const a of anchorBad.slice(0, 10))
	console.log(`  ANCHOR id=${a.id} district=${a.district} buildingCity=${a.bcity}`);

// ---------- (11) override rule matrix ----------
const cityCentroids = new Map([...townIdx.keys()].map((k) => [k, true]));
const TITLE_CITY_FORMS: Record<string, string> = {
	zakopanem: "Zakopane",
	krakowie: "Kraków",
};
function override(cityHint: string | null, title: string): string | null {
	const titleScope = propertyPartOf(title);
	const titleLower = titleScope.toLowerCase();
	const hintKey = normStreet(cityHint ?? "");
	const hintIsSpecificTown =
		hintKey !== "krakow" && cityCentroids.has(hintKey);
	if (!hintIsSpecificTown) {
		for (const [form, city] of Object.entries(TITLE_CITY_FORMS)) {
			if (titleLower.includes(form)) {
				if (!cityHint || normStreet(cityHint) !== normStreet(city)) return city;
				break;
			}
		}
	}
	return cityHint;
}
check(
	"override: specific town survives court seat city",
	override("Nawojowa Góra", "działka przy ul. Szkolnej dla której SR w Krakowie KW nr 1") ===
		"Nawojowa Góra",
);
check(
	"override: generic Kraków still yields to title city",
	override("Kraków", "w Zakopanem przy ul. Paryskich, Kraków") === "Zakopane",
);
check(
	"override: district hint yields to title city",
	override("Krowodrza", "w Zakopanem przy ul. Paryskich") === "Zakopane",
);
check(
	"override: court seat city never wins over a specific town even without cut markers",
	override("Tenczynek", "nieruchomość w Krakowie") === "Tenczynek",
);
check(
	"override: empty hint takes the title city",
	override(null, "mieszkanie w Zakopanem") === "Zakopane",
);
check(
	"override: unresolvable hamlet hint is treated as generic",
	override("Pstroszyce II", "mieszkanie w Zakopanem") === "Zakopane",
);

console.log(
	`\ncorpus: ${rows.length} komornik rows, ${checked} with known town centroid, ${rows.filter((r) => r.lat != null).length} located`,
);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;

// ---------- forensic pass: classify each FAR row ----------
console.log("\n--- FAR forensics (nearest same-name building) ---");
for (const line of far) {
	const id = Number(line.match(/id=(\d+)/)?.[1]);
	const r = rows.find((x) => x.id === id);
	if (!r || r.lat == null || r.lng == null) continue;
	const name = normStreet(r.district ?? "");
	const sameNamed = allBuildings.filter((b) => b.town && normStreet(b.town) === name);
	const dists = sameNamed
		.map((b) => km(r.lat!, r.lng!, b.lat, b.lng))
		.sort((a, b) => a - b);
	const nearest = dists[0];
	const nearCount = dists.filter((d) => d <= 3).length;
	console.log(
		`id=${id} pin=${r.lat.toFixed(4)},${r.lng.toFixed(4)} town=${r.district} ` +
			`addr=${r.address} nearestSameName=${nearest?.toFixed(1) ?? "n/a"}km ` +
			`within3km=${nearCount}/${sameNamed.length}`,
	);
}

// ---------- regression: the 3 reported examples ----------
const expectRows: Array<[number, number, number, number]> = [
	// [id, expected lat, expected lng, max km]
	[69803, 50.120907555555561, 19.628554144444443, 0.05], // Jana III Sobieskiego 84, Tenczynek
	[69857, 50.157196411111123, 19.893761466666668, 0.05], // Zamkowa 5, Przybysławice
	[69805, 50.114588220749305, 19.669797867691411, 0.05], // Szkolna centroid, Nawojowa Góra
];
for (const [id, lat, lng, maxKm] of expectRows) {
	const r = rows.find((x) => x.id === id);
	const d = r?.lat != null && r.lng != null ? km(r.lat, r.lng, lat, lng) : Number.POSITIVE_INFINITY;
	check(`regression: listing ${id} pinned at expected point`, d <= maxKm, `${d.toFixed(3)}km`);
}
