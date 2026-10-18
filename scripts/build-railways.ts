/**
 * Generate `src/data/region-railways.ts` — railway lines and stations for
 * every voivodeship the tracker covers (Małopolska + Śląsk), rendered on
 * the map as a high-contrast overlay ("Kolej" toggle).
 *
 *   bun run build:railways
 *
 * The data comes from the same Geofabrik extracts `osm-index.ts` builds the
 * building index from (`data/osm/<region>.osm.pbf`), not from Overpass: the
 * public Overpass mirrors were all failing (406/500/502) when this was
 * written, and a local extract is deterministic, offline and rate-limit
 * free. The parse is two passes per file (ways first to learn which nodes
 * matter, then the node coords), exactly like `osm-index.ts`.
 *
 * Scope choices: `rail`/`light_rail`/`subway`/`tram` WITHOUT `service=*` or
 * `usage=industrial` — sidings and depot tracks add megabytes and noise to a
 * map whose job is "is there a railway near this offer". Stations come from
 * `railway=station|halt` plus `building=train_station` (some are mapped as
 * buildings only); area stations report their centroid.
 *
 * Data: © OpenStreetMap contributors, ODbL.
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import osmPbf, { type OsmItem } from "osm-pbf-parser";

const OUT_PATH = "src/data/region-railways.ts";
const PBF_PATHS = ["data/osm/malopolskie.osm.pbf", "data/osm/slaskie.osm.pbf"];
const RAILWAYS = new Set(["rail", "light_rail", "subway", "tram"]);
/** Drop waypoints closer than this to their kept neighbour (~1.1 m). */
const MIN_STEP = 0.00001;
/** Output coordinate precision: 5 decimals ≈ 1.1 m. */
const PRECISION = 1e5;

interface Way {
	id: number;
	refs: number[];
	tags: Record<string, string>;
}

interface StationPoint {
	name: string | null;
	pt: [number, number];
}

function round(p: number): number {
	return Math.round(p * PRECISION) / PRECISION;
}

/** Drop waypoints closer than MIN_STEP to the previously kept one. */
function decimate(pts: Array<[number, number]>): Array<[number, number]> {
	if (pts.length <= 2) return pts;
	const out: Array<[number, number]> = [pts[0]];
	for (let i = 1; i < pts.length - 1; i++) {
		const [px, py] = out[out.length - 1];
		const [x, y] = pts[i];
		if (Math.abs(x - px) >= MIN_STEP || Math.abs(y - py) >= MIN_STEP) {
			out.push(pts[i]);
		}
	}
	out.push(pts[pts.length - 1]);
	return out;
}

function forEachItem(
	pbfPath: string,
	visit: (item: OsmItem) => void,
): Promise<void> {
	// osm-pbf-parser is an evented stream emitting batches of items (the
	// shape osm-index.ts consumes); it is not async-iterable.
	return new Promise((resolve, reject) => {
		const osm = osmPbf();
		osm.on("data", (items: OsmItem[]) => {
			for (const item of items) visit(item);
		});
		osm.on("end", resolve);
		osm.on("error", reject);
		createReadStream(pbfPath).pipe(osm);
	});
}

/** Pass 1: matching ways + station points; collect which node ids we need. */
async function collectWays(): Promise<{
	ways: Way[];
	stationWays: Way[];
	stations: StationPoint[];
	needed: Set<number>;
}> {
	const ways: Way[] = [];
	const stationWays: Way[] = [];
	const stations: StationPoint[] = [];
	const needed = new Set<number>();
	for (const pbfPath of PBF_PATHS) {
		if (!existsSync(pbfPath)) {
			throw new Error(
				`${pbfPath} missing — run "bun run assign-buildings" once (it downloads the extracts) or fetch it from Geofabrik`,
			);
		}
		await forEachItem(pbfPath, (item) => {
			if (item.type === "way") {
				const tags = (item.tags ?? {}) as Record<string, string>;
				const refs = (item.refs ?? []) as number[];
				if (tags.railway === "station" || tags.railway === "halt") {
					stationWays.push({ id: item.id, refs, tags });
					for (const r of refs) needed.add(r);
					return;
				}
				if (
					RAILWAYS.has(tags.railway ?? "") &&
					!("service" in tags) &&
					tags.usage !== "industrial" &&
					refs.length >= 2
				) {
					ways.push({ id: item.id, refs, tags });
					for (const r of refs) needed.add(r);
				}
			} else if (item.type === "node") {
				const tags = (item.tags ?? {}) as Record<string, string>;
				if (
					tags.railway === "station" ||
					tags.railway === "halt" ||
					tags.building === "train_station"
				) {
					if (item.lat != null && item.lon != null) {
						stations.push({
							name: tags.name ?? null,
							pt: [round(item.lon), round(item.lat)],
						});
					}
				}
			}
		});
		console.log(`pass 1 done: ${pbfPath}`);
	}
	return { ways, stationWays, stations, needed };
}

/** Pass 2: coordinates for exactly the node ids pass 1 kept. */
async function collectCoords(needed: Set<number>): Promise<Map<number, [number, number]>> {
	const coords = new Map<number, [number, number]>();
	for (const pbfPath of PBF_PATHS) {
		await forEachItem(pbfPath, (item) => {
			if (item.type === "node" && needed.has(item.id) && item.lat != null && item.lon != null) {
				coords.set(item.id, [item.lon, item.lat]);
			}
		});
		console.log(`pass 2 done: ${pbfPath} (${coords.size} node coords)`);
	}
	return coords;
}

const { ways, stationWays, stations, needed } = await collectWays();
const coords = await collectCoords(needed);

const lines: Array<Array<[number, number]>> = [];
for (const w of ways) {
	const pts: Array<[number, number]> = [];
	for (const ref of w.refs) {
		const c = coords.get(ref);
		if (c) pts.push([round(c[0]), round(c[1])]);
	}
	const dec = decimate(pts);
	if (dec.length >= 2) lines.push(dec);
}

// Area stations: one label at the centre of mass of their resolved ring.
for (const w of stationWays) {
	let sx = 0;
	let sy = 0;
	let n = 0;
	for (const ref of w.refs) {
		const c = coords.get(ref);
		if (c) {
			sx += c[0];
			sy += c[1];
			n++;
		}
	}
	if (n > 0) {
		stations.push({
			name: w.tags.name ?? null,
			pt: [round(sx / n), round(sy / n)],
		});
	}
}

// A station mapped both as node and area gets two entries; dedupe by point.
const seenPts = new Set<string>();
const uniqueStations = stations.filter((s) => {
	const key = `${s.pt[0]},${s.pt[1]}`;
	if (seenPts.has(key)) return false;
	seenPts.add(key);
	return true;
});

const body = `// Generated by scripts/build-railways.ts (Geofabrik extracts; © OpenStreetMap
// contributors, ODbL). Railway lines and stations for the tracked regions,
// rendered on the map as the "Kolej" overlay. Regenerate:
//   bun run build:railways

export const RAIL_LINES: Array<Array<[number, number]>> = ${JSON.stringify(lines)};

export interface RailwayStation {
\tname: string | null;
\tpt: [number, number];
}

export const RAIL_STATIONS: RailwayStation[] = ${JSON.stringify(uniqueStations)};
`;
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, body);

console.log(
	`lines: ${lines.length} (avg ${(lines.reduce((a, l) => a + l.length, 0) / Math.max(1, lines.length)).toFixed(1)} pts), ` +
		`stations: ${uniqueStations.length}, out: ${(body.length / 1024 / 1024).toFixed(1)} MB`,
);
