/**
 * Generate `src/data/malopolska-powiats.ts` — the powiat (admin_level=6)
 * boundary rings used by `/api/powiat-map` for point-in-polygon assignment.
 *
 * The previous copy of that module was lost because `.gitignore`'s `data/`
 * rule also matched `src/data/` (fixed: the rule is now `/data/`), and
 * `src/routes/api/powiat-map.ts` imported a file that no clone had. This
 * script makes the dataset reproducible.
 *
 *   bun run build:powiats            # use the cached Overpass response
 *   bun run build:powiats -- --refresh
 *
 * Steps: fetch every admin_level=6 relation inside the małopolska
 * voivodeship from Overpass (cached under data/powiats/), stitch the
 * member ways into closed rings, simplify (Douglas-Peucker, ~90 m), drop
 * specks, and emit a compact TS module.
 *
 * Data: © OpenStreetMap contributors, ODbL.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const CACHE_PATH = "data/powiats/overpass-powiats.json";
const OUT_PATH = "src/data/malopolska-powiats.ts";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
/** Douglas-Peucker tolerance in degrees (~90 m at 50 °N). */
const TOLERANCE = 0.0008;
/** Rings smaller than this (~0.4 km²) are dropped as specks. */
const MIN_RING_AREA = 0.00005;

const QUERY = `[out:json][timeout:300];
area["name"="województwo małopolskie"]["admin_level"="4"]->.a;
rel(area.a)["admin_level"="6"]["boundary"="administrative"];
out geom;`;

type LonLat = [number, number];

interface OverpassWay {
	role: string;
	geometry?: Array<{ lat: number; lon: number }>;
}

interface OverpassRelation {
	type: string;
	id: number;
	tags?: Record<string, string>;
	members?: OverpassWay[];
}

async function fetchOverpass(refresh: boolean): Promise<OverpassRelation[]> {
	if (!refresh) {
		try {
			const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as {
				elements: OverpassRelation[];
			};
			console.log(`Using cached ${CACHE_PATH}`);
			return cached.elements;
		} catch {
			// cache miss -> fetch below
		}
	}
	console.log(`Querying Overpass (${OVERPASS_URL}) ...`);
	const res = await fetch(OVERPASS_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": "flat-tracker/1.1 (powiat boundaries; OSM ODbL)",
		},
		body: new URLSearchParams({ data: QUERY }),
		signal: AbortSignal.timeout(300_000),
	});
	if (!res.ok) throw new Error(`Overpass failed: HTTP ${res.status}`);
	const json = (await res.json()) as { elements: OverpassRelation[] };
	mkdirSync(dirname(CACHE_PATH), { recursive: true });
	writeFileSync(CACHE_PATH, JSON.stringify(json));
	console.log(`Cached ${json.elements.length} relations to ${CACHE_PATH}`);
	return json.elements;
}

/** Closed rings from member ways, greedily glued end-to-end. */
function stitchRings(ways: LonLat[][]): LonLat[][] {
	const key = (p: LonLat) => `${p[0]},${p[1]}`;
	const pool = ways.filter((w) => w.length >= 2).map((w) => [...w]);
	const rings: LonLat[][] = [];

	while (pool.length > 0) {
		let ring = pool.pop() as LonLat[];
		let extended = true;
		while (extended) {
			extended = false;
			const head = key(ring[0]);
			const tail = key(ring[ring.length - 1]);
			if (head === tail && ring.length > 3) break;
			for (let i = pool.length - 1; i >= 0; i--) {
				const w = pool[i];
				const ws = key(w[0]);
				const we = key(w[w.length - 1]);
				if (we === tail) ring = ring.concat(w.slice(1));
				else if (ws === tail) ring = ring.concat([...w].reverse().slice(1));
				else if (we === head) ring = w.slice(0, -1).concat(ring);
				else if (ws === head) ring = [...w].reverse().slice(0, -1).concat(ring);
				else continue;
				pool.splice(i, 1);
				extended = true;
				break;
			}
		}
		if (ring.length > 3) rings.push(ring);
	}
	return rings;
}

/** Signed shoelace area in square degrees (sign tells winding). */
function ringArea(ring: LonLat[]): number {
	let sum = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
	}
	return sum / 2;
}

/** Perpendicular distance from p to the segment ab, in degrees. */
function segDistance(p: LonLat, a: LonLat, b: LonLat): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = dx * dx + dy * dy;
	if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker on an open polyline. */
function simplify(points: LonLat[], tolerance: number): LonLat[] {
	if (points.length < 3) return points;
	let maxDist = 0;
	let index = 0;
	for (let i = 1; i < points.length - 1; i++) {
		const d = segDistance(points[i], points[0], points[points.length - 1]);
		if (d > maxDist) {
			maxDist = d;
			index = i;
		}
	}
	if (maxDist <= tolerance) return [points[0], points[points.length - 1]];
	const left = simplify(points.slice(0, index + 1), tolerance);
	const right = simplify(points.slice(index), tolerance);
	return left.slice(0, -1).concat(right);
}

/** Simplify a closed ring: split at the two farthest-apart points first. */
function simplifyRing(ring: LonLat[], tolerance: number): LonLat[] {
	const pts = ring.slice(0, -1); // drop duplicate closing point
	if (pts.length < 4) return ring;
	// Douglas-Peucker needs an open line; anchor on the point farthest from
	// the first one so the seam lands where the ring is most detailed.
	let far = 0;
	let best = -1;
	for (let i = 1; i < pts.length; i++) {
		const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
		if (d > best) {
			best = d;
			far = i;
		}
	}
	const first = simplify(pts.slice(0, far + 1), tolerance);
	const second = simplify(pts.slice(far).concat([pts[0]]), tolerance);
	const merged = first.slice(0, -1).concat(second);
	return merged;
}

/** Strip the "powiat " prefix; city powiaty keep their bare name. */
function powiatName(raw: string): string {
	return raw.replace(/^powiat\s+/i, "").trim();
}

function round(ring: LonLat[]): LonLat[] {
	return ring.map(
		([lon, lat]) => [Number(lon.toFixed(4)), Number(lat.toFixed(4))] as LonLat,
	);
}

async function main(): Promise<void> {
	const refresh = process.argv.includes("--refresh");
	const relations = await fetchOverpass(refresh).then((rs) =>
		rs.filter(
			(r) =>
				r.type === "relation" &&
				r.tags?.admin_level === "6" &&
				r.tags?.boundary === "administrative",
		),
	);

	const features: Array<{
		name: string;
		rings: LonLat[][];
	}> = [];

	for (const rel of relations.sort((a, b) =>
		(a.tags?.name ?? "").localeCompare(b.tags?.name ?? "", "pl"),
	)) {
		const name = powiatName(rel.tags?.name ?? "");
		if (!name) continue;
		const roleRings = (role: string): LonLat[][] => {
			const ways = (rel.members ?? [])
				.filter((m) => m.role === role && Array.isArray(m.geometry))
				.map((m) => (m.geometry ?? []).map((p) => [p.lon, p.lat] as LonLat));
			return stitchRings(ways)
				.filter((r) => Math.abs(ringArea(r)) >= MIN_RING_AREA)
				.map((r) => round(simplifyRing(r, TOLERANCE)))
				.filter((r) => r.length >= 4);
		};
		// Outer rings first, then holes. Holes are the enclaves of city
		// powiaty inside land powiaty (Tarnów in tarnowski, Nowy Sącz in
		// nowosądecki); the consumer tests them with an even-odd rule, so a
		// point inside a city is not also counted into the surrounding powiat.
		const rings = [...roleRings("outer"), ...roleRings("inner")];
		const points = rings.reduce((n, r) => n + r.length, 0);
		console.log(`${name}: ${rings.length} ring(s), ${points} points`);
		if (rings.length > 0) features.push({ name, rings });
	}

	if (features.length === 0) throw new Error("no powiat rings produced");

	const body = features
		.map(
			(f) =>
				`\t{\n\t\tproperties: { name: ${JSON.stringify(f.name)} },\n\t\tgeometry: {\n\t\t\ttype: "MultiPolygon",\n\t\t\tcoordinates: [${f.rings
					.map((r) => `[${r.map((p) => `[${p[0]},${p[1]}]`).join(",")}]`)
					.join(",")}],\n\t\t},\n\t},`,
		)
		.join("\n");

	const out = `/**
 * Małopolska powiat (admin_level=6) boundary rings, keyed by plain powiat
 * name ("krakowski", "Kraków", ...). Used by \`/api/powiat-map\` for
 * point-in-polygon powiat assignment.
 *
 * \`coordinates\` holds one closed ring per array: outer boundaries first,
 * then holes (city powiaty enclosed by a land powiat, e.g. Tarnów inside
 * tarnowski). A point belongs to the powiat when it is inside an ODD
 * number of rings (even-odd rule), so city centres are not also counted
 * into the powiat around them.
 *
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *   bun run build:powiats            # cached Overpass response
 *   bun run build:powiats -- --refresh
 *
 * Source: OpenStreetMap via Overpass API, © OpenStreetMap contributors (ODbL).
 * Rings are simplified (Douglas-Peucker, ~${Math.round(TOLERANCE * 111_000)} m) and rounded to 4 decimals.
 */

export interface PowiatFeature {
\tproperties: { name: string };
\tgeometry: {
\t\ttype: "MultiPolygon";
\t\t/** Closed lon/lat rings (first === last), outers then holes. */
\t\tcoordinates: Array<Array<[number, number]>>;
\t};
}

export const malopolskaPowiats: PowiatFeature[] = [
${body}
];
`;

	mkdirSync(dirname(OUT_PATH), { recursive: true });
	writeFileSync(OUT_PATH, out);
	console.log(
		`Wrote ${OUT_PATH}: ${features.length} powiaty, ${(out.length / 1024).toFixed(0)} kB`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
