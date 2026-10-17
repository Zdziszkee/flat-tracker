/**
 * Validate `src/data/region-powiats.ts` — the generated powiat boundaries the
 * choropleth assigns points with. `bun run validate:powiats`.
 *
 * The generator can only prove the file is well-formed; the failure modes that
 * matter are geographic:
 *
 * - a voivodeship silently missing (an Overpass retry that produced a partial
 *   dataset), or a city on prawa powiatu missing from the file;
 * - a city centre landing in the land powiat around it (the Małopolska city
 *   powiaty are holes in their surrounding powiat, tested with the even-odd
 *   rule; the Śląskie ones are separate polygons, so the check must hold for
 *   both shapes);
 * - a point belonging to two powiats (overlaps only happen on the ~90 m
 *   simplified border strips and would make the assignment order-dependent).
 *
 * No DB, no network: reads the generated file only.
 */

import { regionPowiats } from "../src/data/region-powiats";

type Ring = Array<[number, number]>;

interface Poly {
	name: string;
	voivodeship: string;
	rings: Ring[];
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

/** Every city on prawa powiatu in both voivodeships + its centre. */
const CITY_CENTRES: Array<[string, number, number]> = [
	["Kraków", 19.94, 50.06],
	["Tarnów", 20.985, 50.012],
	["Nowy Sącz", 20.69, 49.62],
	["Bielsko-Biała", 19.06, 49.82],
	["Bytom", 18.91, 50.35],
	["Chorzów", 18.95, 50.3],
	["Częstochowa", 19.12, 50.81],
	["Dąbrowa Górnicza", 19.19, 50.32],
	["Gliwice", 18.67, 50.3],
	["Jastrzębie-Zdrój", 18.6, 49.95],
	["Jaworzno", 19.27, 50.2],
	["Katowice", 19.02, 50.26],
	["Mysłowice", 19.167, 50.2075],
	["Piekary Śląskie", 18.95, 50.38],
	["Ruda Śląska", 18.85, 50.26],
	["Rybnik", 18.55, 50.09],
	["Siemianowice Śląskie", 19.03, 50.33],
	["Sosnowiec", 19.13, 50.28],
	["Świętochłowice", 18.92, 50.3],
	["Tychy", 18.99, 50.13],
	["Zabrze", 18.79, 50.32],
	["Żory", 18.7, 50.04],
];

/** Largest accepted share of sampled points inside more than one powiat. */
const MAX_OVERLAP_SHARE = 0.001;

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if (
			yi > lat !== yj > lat &&
			lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
		) {
			inside = !inside;
		}
	}
	return inside;
}

const polys: Poly[] = regionPowiats.map((f) => {
	const rings = f.geometry.coordinates as Ring[];
	let minLon = Number.POSITIVE_INFINITY;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	for (const ring of rings) {
		for (const [lon, lat] of ring) {
			if (lon < minLon) minLon = lon;
			if (lon > maxLon) maxLon = lon;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
		}
	}
	return { name: f.properties.name, voivodeship: f.properties.voivodeship, rings, minLon, minLat, maxLon, maxLat };
});

/** Inside an odd number of rings (outers minus holes), per powiat. */
const contains = (lon: number, lat: number, p: Poly): boolean =>
	p.rings.filter((r) => pointInRing(lon, lat, r)).length % 2 === 1;

const hits = (lon: number, lat: number): string[] =>
	polys
		.filter(
			(p) =>
				lon >= p.minLon &&
				lon <= p.maxLon &&
				lat >= p.minLat &&
				lat <= p.maxLat &&
				contains(lon, lat, p),
		)
		.map((p) => p.name);

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.error(`FAIL ${msg}`);
};

// --- shape ---
for (const f of regionPowiats) {
	const name = f.properties.name;
	const rings = f.geometry.coordinates as Ring[];
	if (!f.properties.voivodeship) fail(`${name}: no voivodeship tag`);
	if (rings.length === 0) fail(`${name}: no rings`);
	for (const ring of rings) {
		if (ring.length < 4) fail(`${name}: ring with ${ring.length} points`);
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (first[0] !== last[0] || first[1] !== last[1]) {
			fail(`${name}: ring is not closed`);
		}
	}
}

const names = new Set(polys.map((p) => p.name));
if (names.size !== polys.length) {
	fail(`duplicate powiat names (${polys.length} features, ${names.size} unique)`);
}

// --- coverage ---
const byVoivodeship = new Map<string, number>();
for (const p of polys) {
	byVoivodeship.set(p.voivodeship, (byVoivodeship.get(p.voivodeship) ?? 0) + 1);
}
for (const [voivodeship, expected] of [
	["małopolskie", 22],
	["śląskie", 36],
] as Array<[string, number]>) {
	const got = byVoivodeship.get(voivodeship) ?? 0;
	if (got !== expected) {
		fail(`${voivodeship}: ${got} powiaty, expected ${expected}`);
	}
}

// --- city centres resolve to their own powiat ---
for (const [city, lon, lat] of CITY_CENTRES) {
	if (!names.has(city)) {
		fail(`${city}: city powiat missing from the dataset`);
		continue;
	}
	const found = hits(lon, lat);
	if (!found.includes(city)) {
		fail(`${city} centre (${lat}, ${lon}) resolves to [${found.join(", ")}]`);
	}
}

// --- overlaps (grid sweep) ---
let samples = 0;
let multi = 0;
const examples: string[] = [];
for (let lat = 49.3; lat <= 51.05; lat += 0.01) {
	for (let lon = 18.25; lon <= 21.5; lon += 0.01) {
		samples++;
		const found = hits(lon, lat);
		if (found.length > 1) {
			multi++;
			if (examples.length < 5) {
				examples.push(`${lat.toFixed(2)},${lon.toFixed(2)} -> ${found.join(" + ")}`);
			}
		}
	}
}
const share = multi / samples;
console.log(
	`overlaps: ${multi}/${samples} sampled points (${(share * 100).toFixed(4)}%)` +
		(examples.length > 0 ? `, e.g. ${examples.join("; ")}` : ""),
);
if (share > MAX_OVERLAP_SHARE) {
	fail(`too many overlapping points (${(share * 100).toFixed(4)}%)`);
}

console.log(
	`powiaty: ${polys.length} (${[...byVoivodeship.entries()]
		.map(([v, n]) => `${v}: ${n}`)
		.join(", ")}), cities checked: ${CITY_CENTRES.length}`,
);

if (failures > 0) {
	console.error(`${failures} check(s) failed`);
	process.exit(1);
}
console.log("OK");
