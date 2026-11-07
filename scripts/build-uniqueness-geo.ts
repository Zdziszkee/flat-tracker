/**
 * Generate `src/data/region-uniqueness.ts` from the local Geofabrik extracts.
 *
 *   bun run build:uniqueness
 *
 * Output is intentionally small enough to commit: polygons/lines are
 * Douglas-Peucker simplified and coordinates rounded. Only ways are used;
 * large multipolygon relations are a documented gap, not silently treated as
 * complete coverage.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { forEachPbfItem } from "../src/crawler/osm/pbf.ts";

const OUT_PATH = "src/data/region-uniqueness.ts";
const PBF_PATHS = ["data/osm/malopolskie.osm.pbf", "data/osm/slaskie.osm.pbf"];
const GREEN_SIMPLIFY = 0.0005;
const WATER_SIMPLIFY = 0.0005;
const RIVER_SIMPLIFY = 0.0002;

type Coord = [number, number];
interface Way {
	id: number;
	refs: number[];
	tags: Record<string, string>;
}
interface GreenPolygon {
	kind: "park" | "forest";
	ring: Coord[];
}
interface WaterPolygon {
	kind: "water";
	ring: Coord[];
}
interface RiverLine {
	kind: "river" | "stream" | "canal";
	points: Coord[];
}
interface TransitPoint {
	kind: "train" | "tram" | "bus" | "subway";
	name: string | null;
	pt: Coord;
}

function round(value: number): number {
	return Math.round(value * 100000) / 100000;
}

function distanceSqPointToSegment(p: Coord, a: Coord, b: Coord): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	if (dx === 0 && dy === 0) {
		return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
	}
	const numerator = (p[0] - a[0]) * dx + (p[1] - a[1]) * dy;
	const denominator = dx * dx + dy * dy;
	const t = Math.max(0, Math.min(1, numerator / denominator));
	return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
}

function rdp(points: readonly Coord[], tolerance: number): Coord[] {
	if (points.length <= 2) return [...points];
	let maxDistance = 0;
	let index = 0;
	const first = points[0];
	const last = points[points.length - 1];
	if (!first || !last) return [...points];
	for (let i = 1; i < points.length - 1; i++) {
		const point = points[i];
		if (!point) continue;
		const distance = distanceSqPointToSegment(point, first, last);
		if (distance > maxDistance) {
			maxDistance = distance;
			index = i;
		}
	}
	if (maxDistance <= tolerance * tolerance) return [first, last];
	const left = rdp(points.slice(0, index + 1), tolerance);
	const right = rdp(points.slice(index), tolerance);
	return [...left.slice(0, -1), ...right];
}

function centroid(points: readonly Coord[]): Coord | null {
	if (points.length === 0) return null;
	let x = 0;
	let y = 0;
	for (const point of points) {
		x += point[0];
		y += point[1];
	}
	return [round(x / points.length), round(y / points.length)];
}

function transitKind(
	tags: Record<string, string>,
): TransitPoint["kind"] | null {
	if (tags.railway === "tram_stop") return "tram";
	if (tags.railway === "subway_station") return "subway";
	if (
		tags.railway === "station" ||
		tags.railway === "halt" ||
		tags.building === "train_station" ||
		tags.train === "yes"
	) {
		return "train";
	}
	if (tags.highway === "bus_stop" || tags.bus === "yes") return "bus";
	return null;
}

const greenWays: Way[] = [];
const waterWays: Way[] = [];
const riverWays: Way[] = [];
const transitWays: Way[] = [];
const transitPoints: TransitPoint[] = [];
const needed = new Set<number>();

for (const pbfPath of PBF_PATHS) {
	if (!existsSync(pbfPath)) {
		throw new Error(
			`${pbfPath} missing — run "bun run assign-buildings" once or fetch the Geofabrik extracts`,
		);
	}
	await forEachPbfItem(pbfPath, (item) => {
		const tags = (item.tags ?? {}) as Record<string, string>;
		if (item.type === "node") {
			const kind = transitKind(tags);
			if (kind && item.lat != null && item.lon != null) {
				transitPoints.push({
					kind,
					name: tags.name ?? null,
					pt: [round(item.lon), round(item.lat)],
				});
			}
			return;
		}
		if (item.type !== "way") return;
		const refs = (item.refs ?? []) as number[];
		const way = { id: item.id, refs, tags };
		const isGreen =
			tags.leisure === "park" || tags.landuse === "forest" || tags.natural === "wood";
		const isWater =
			tags.natural === "water" || tags.water === "lake" || tags.landuse === "reservoir";
		const isRiver =
			tags.waterway === "river" ||
			((tags.waterway === "stream" || tags.waterway === "canal") &&
				typeof tags.name === "string" &&
				tags.name.length > 0);
		const isTransit = transitKind(tags) != null;
		if (isGreen && refs.length >= 4) greenWays.push(way);
		if (isWater && refs.length >= 4) waterWays.push(way);
		if (isRiver && refs.length >= 2) riverWays.push(way);
		if (isTransit && refs.length >= 1) transitWays.push(way);
		if ((isGreen || isWater || isRiver || isTransit) && refs.length > 0) {
			for (const ref of refs) needed.add(ref);
		}
	});
	console.log(`pass 1 done: ${pbfPath}`);
}

const coords = new Map<number, Coord>();
for (const pbfPath of PBF_PATHS) {
	await forEachPbfItem(pbfPath, (item) => {
		if (item.type === "node" && needed.has(item.id) && item.lat != null && item.lon != null) {
			coords.set(item.id, [item.lon, item.lat]);
		}
	});
	console.log(`pass 2 done: ${pbfPath} (${coords.size} coords)`);
}

function wayCoords(way: Way): Coord[] {
	const out: Coord[] = [];
	for (const ref of way.refs) {
		const point = coords.get(ref);
		if (point) out.push(point);
	}
	return out;
}

const greenPolygons: GreenPolygon[] = [];
for (const way of greenWays) {
	const points = rdp(wayCoords(way), GREEN_SIMPLIFY).map(
		([x, y]) => [round(x), round(y)] as Coord,
	);
	if (points.length < 4) continue;
	greenPolygons.push({
		kind: way.tags.leisure === "park" ? "park" : "forest",
		ring: points,
	});
}

const waterPolygons: WaterPolygon[] = [];
for (const way of waterWays) {
	const points = rdp(wayCoords(way), WATER_SIMPLIFY).map(
		([x, y]) => [round(x), round(y)] as Coord,
	);
	if (points.length < 4) continue;
	waterPolygons.push({ kind: "water", ring: points });
}

const riverLines: RiverLine[] = [];
for (const way of riverWays) {
	const points = rdp(wayCoords(way), RIVER_SIMPLIFY).map(
		([x, y]) => [round(x), round(y)] as Coord,
	);
	if (points.length < 2) continue;
	riverLines.push({
		kind: (way.tags.waterway as RiverLine["kind"]) ?? "river",
		points,
	});
}

for (const way of transitWays) {
	const kind = transitKind(way.tags);
	const point = centroid(wayCoords(way));
	if (kind && point) {
		transitPoints.push({ kind, name: way.tags.name ?? null, pt: point });
	}
}

const seen = new Set<string>();
const uniqueTransit = transitPoints.filter((point) => {
	const key = `${point.kind}:${point.pt[0]},${point.pt[1]}`;
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
});

const body = `// Generated by scripts/build-uniqueness-geo.ts from local Geofabrik extracts.
// © OpenStreetMap contributors, ODbL. Regenerate: bun run build:uniqueness
// Ways only; multipolygon relations are not expanded.

export interface GreenPolygon {
	kind: "park" | "forest";
	ring: [number, number][];
}
export const GREEN_POLYGONS: GreenPolygon[] = ${JSON.stringify(greenPolygons)};

export interface WaterPolygon {
	kind: "water";
	ring: [number, number][];
}
export const WATER_POLYGONS: WaterPolygon[] = ${JSON.stringify(waterPolygons)};

export interface RiverLine {
	kind: "river" | "stream" | "canal";
	points: [number, number][];
}
export const RIVER_LINES: RiverLine[] = ${JSON.stringify(riverLines)};

export interface TransitPoint {
	kind: "train" | "tram" | "bus" | "subway";
	name: string | null;
	pt: [number, number];
}
export const TRANSIT_POINTS: TransitPoint[] = ${JSON.stringify(uniqueTransit)};
`;
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, body);
console.log(
	`green=${greenPolygons.length} water=${waterPolygons.length} rivers=${riverLines.length} transit=${uniqueTransit.length} ` +
		`size=${(body.length / 1024 / 1024).toFixed(1)} MB`,
);
