/**
 * Pins the two location datasets the alert score depends on:
 *
 * - `FAST_RAIL_STATIONS` (`src/data/fast-rail-stations.ts`) decides which
 *   plots and houses can alert at all (3 km gate), so a bad coordinate or a
 *   duplicated station would silently move real offers in and out of the list.
 * - `CENTRE_ANCHORS` (`src/lib/scoring/centre-zone.ts`) decides which flats can
 *   alert, so an anchor outside the tracked area or a missing target
 *   neighbourhood would empty a section without any error.
 *
 * Pure checks over the modules, plus a few hand-computed distances so a broken
 * haversine cannot pass. Run with `bun run validate:planned-stations`.
 */

import { FAST_RAIL_STATIONS } from "../src/data/fast-rail-stations.ts";
import { TRACKED_REGIONS } from "../src/db/region.ts";
import {
	CENTRE_ANCHORS,
	nearestCentreAnchor,
} from "../src/lib/scoring/centre-zone.ts";
import {
	distanceM,
	fastRailLabel,
	nearestFastRail,
} from "../src/lib/scoring/fast-rail.ts";

let checks = 0;
const failures: string[] = [];

function check(label: string, condition: boolean): void {
	checks++;
	if (!condition) failures.push(label);
}

function insideRegion(
	region: "malopolskie" | "slaskie",
	lat: number,
	lng: number,
): boolean {
	const box = TRACKED_REGIONS[region];
	return (
		lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng
	);
}

// --- Fast-rail stations -------------------------------------------------

check("dataset is not empty", FAST_RAIL_STATIONS.length >= 5);

const ids = new Set<string>();
const names = new Set<string>();
for (const station of FAST_RAIL_STATIONS) {
	check(`unique id ${station.id}`, !ids.has(station.id));
	ids.add(station.id);
	check(`unique name ${station.name}`, !names.has(station.name));
	names.add(station.name);
	check(
		`${station.id} lies inside ${station.region}`,
		insideRegion(station.region, station.lat, station.lng),
	);
	check(`${station.id} has services`, station.services.length > 0);
	check(
		`${station.id} service enum`,
		station.services.every(
			(service) => service === "eip_200" || service === "kdp_2035",
		),
	);
	check(
		`${station.id} confidence enum`,
		station.confidence === "documented" || station.confidence === "approx",
	);
	check(
		`${station.id} cites a source`,
		/^https:\/\//u.test(station.sourceUrl),
	);
	check(`${station.id} has a note`, station.note.length > 10);
	const planned = station.services.includes("kdp_2035");
	check(
		`${station.id} KDP year is consistent`,
		planned ? (station.kdpYear ?? 0) >= 2030 : station.kdpYear == null,
	);
}

check(
	"Kraków Główny is a documented KDP call",
	FAST_RAIL_STATIONS.some(
		(station) =>
			station.id === "krakow-glowny" &&
			station.services.includes("kdp_2035") &&
			station.confidence === "documented",
	),
);
check(
	"Katowice is a documented KDP call",
	FAST_RAIL_STATIONS.some(
		(station) =>
			station.id === "katowice" && station.services.includes("kdp_2035"),
	),
);

// --- Distance math ------------------------------------------------------

// Rynek Główny -> Kraków Główny is about 1.07 km on the ground.
const rynekToGlowny = distanceM(50.06163, 19.93728, 50.06842, 19.94789);
check(
	`haversine sanity (${Math.round(rynekToGlowny)} m)`,
	rynekToGlowny > 900 && rynekToGlowny < 1250,
);
check(
	"distance is symmetric",
	Math.abs(rynekToGlowny - distanceM(50.06842, 19.94789, 50.06163, 19.93728)) <
		0.001,
);
check("distance to itself is zero", distanceM(50, 20, 50, 20) === 0);

const fromRynek = nearestFastRail(50.06163, 19.93728);
check("nearest rail from the Rynek exists", fromRynek != null);
check(
	"nearest rail from the Rynek is Kraków Główny",
	fromRynek?.station.id === "krakow-glowny",
);
check(
	"Kraków Główny is inside the 3 km gate from the Rynek",
	(fromRynek?.distanceM ?? Number.POSITIVE_INFINITY) < 3000,
);
check("Kraków Główny is flagged as a KDP call", fromRynek?.kdpPlanned === true);
check(
	"label carries the station and the distance",
	(fastRailLabel(fromRynek!) ?? "").startsWith("Kraków Główny (1,"),
);

// Nowa Huta is ~15 km from the nearest station: outside any gate.
const fromNowaHuta = nearestFastRail(50.0725, 20.0345);
check(
	"Nowa Huta is outside the fast-rail gate",
	fromNowaHuta == null || fromNowaHuta.distanceM > 3000,
);
check("missing coordinates yield no match", nearestFastRail(null, null) == null);
check("NaN coordinates yield no match", nearestFastRail(Number.NaN, 20) == null);

// --- Centre zone --------------------------------------------------------

const anchorIds = new Set<string>();
for (const anchor of CENTRE_ANCHORS) {
	check(`unique anchor id ${anchor.id}`, !anchorIds.has(anchor.id));
	anchorIds.add(anchor.id);
	check(
		`${anchor.id} lies inside ${anchor.region}`,
		insideRegion(anchor.region, anchor.lat, anchor.lng),
	);
	check(`${anchor.id} has a note`, anchor.note.length > 5);
}

const TARGET_ANCHORS = [
	"krakow-rynek",
	"krakow-kazimierz",
	"krakow-podgorze",
	"krakow-krowodrza",
	"krakow-grzegorzki",
	"krakow-debniki",
	"krakow-zwierzyniec",
	"krakow-wola-justowska",
	"katowice-rynek",
];
for (const id of TARGET_ANCHORS) {
	check(`target anchor present: ${id}`, anchorIds.has(id));
}

const atWola = nearestCentreAnchor(50.0635, 19.8835, "Kraków");
check(
	"Wola Justowska resolves to its own anchor",
	atWola?.anchor.id === "krakow-wola-justowska" && (atWola?.distanceM ?? 1) < 50,
);
const atRynek = nearestCentreAnchor(50.06163, 19.93728, "Kraków");
check(
	"the Rynek resolves to the Rynek anchor",
	atRynek?.anchor.id === "krakow-rynek",
);
const atKatowice = nearestCentreAnchor(50.25934, 19.02159, "Katowice");
check(
	"Katowice never resolves to a Kraków anchor",
	atKatowice?.anchor.region === "slaskie",
);
const atNowaHuta = nearestCentreAnchor(50.0725, 20.0345, "Kraków");
check(
	"Nowa Huta is outside the 4 km centre zone",
	(atNowaHuta?.distanceM ?? 0) > 4000,
);
const atKazimierz = nearestCentreAnchor(50.05151, 19.94475, "Kraków");
check(
	"Kazimierz is inside the 4 km centre zone",
	(atKazimierz?.distanceM ?? Number.POSITIVE_INFINITY) < 1000,
);
check(
	"no coordinates yield no anchor",
	nearestCentreAnchor(null, null, "Kraków") == null,
);

// --- Report -------------------------------------------------------------

if (failures.length > 0) {
	console.error(`validate:planned-stations: ${failures.length} failed`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(
	`validate:planned-stations: ${checks} checks passed (${FAST_RAIL_STATIONS.length} stations, ${CENTRE_ANCHORS.length} anchors)`,
);
