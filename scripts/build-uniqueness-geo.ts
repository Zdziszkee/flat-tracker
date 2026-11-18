/**
 * Generate `src/data/region-uniqueness.ts` from the local Geofabrik extracts.
 *
 *   bun run build:uniqueness
 *
 * Output is intentionally small enough to commit: polygons/lines are
 * Douglas-Peucker simplified and coordinates rounded. Green areas come from
 * tagged ways plus multipolygon relations (their outer ways are stitched into
 * closed rings), so a park mapped as a relation is not missing. Every green
 * and water polygon carries the OSM `name` when the source tags one.
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
type PolygonKind = "park" | "forest";
interface Way {
	id: number;
	refs: number[];
	tags: Record<string, string>;
}
interface RelationMember {
	type: string;
	id: number;
	role?: string;
}
interface RelationItem {
	type: "relation";
	id: number;
	tags: Record<string, string>;
	members?: RelationMember[];
}
interface GreenRelation {
	id: number;
	kind: PolygonKind;
	name: string | null;
	outerWayIds: number[];
}
interface GreenPolygon {
	kind: PolygonKind;
	name: string | null;
	ring: Coord[];
}
interface WaterPolygon {
	kind: "water";
	name: string | null;
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

function osmName(tags: Record<string, string>): string | null {
	const name = typeof tags.name === "string" ? tags.name.trim() : "";
	return name.length > 0 ? name : null;
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

function isGreenTags(tags: Record<string, string>): boolean {
	return (
		tags.leisure === "park" ||
		tags.landuse === "forest" ||
		tags.natural === "wood"
	);
}

function greenKind(tags: Record<string, string>): PolygonKind {
	return tags.leisure === "park" ? "park" : "forest";
}

/**
 * Stitch a relation's outer ways into closed rings by matching endpoint node
 * refs. Ways are appended (and reversed when needed) until the chain returns
 * to its start; chains that never close are dropped.
 */
function stitchRings(refLists: readonly (readonly number[])[]): number[][] {
	const pool = refLists
		.filter((refs) => refs.length >= 2)
		.map((refs) => [...refs]);
	const used = new Array<boolean>(pool.length).fill(false);
	const rings: number[][] = [];
	for (let start = 0; start < pool.length; start++) {
		if (used[start]) continue;
		used[start] = true;
		const first = pool[start];
		if (!first) continue;
		const chain = [...first];
		let closed = chain[0] === chain[chain.length - 1];
		while (!closed) {
			const end = chain[chain.length - 1];
			let next = -1;
			let reverse = false;
			for (let i = 0; i < pool.length; i++) {
				if (used[i]) continue;
				const candidate = pool[i];
				if (!candidate) continue;
				if (candidate[0] === end) {
					next = i;
					break;
				}
				if (candidate[candidate.length - 1] === end) {
					next = i;
					reverse = true;
					break;
				}
			}
			if (next < 0) break;
			used[next] = true;
			const candidate = pool[next];
			if (!candidate) break;
			const oriented = reverse ? [...candidate].reverse() : candidate;
			chain.push(...oriented.slice(1));
			if (chain[0] === chain[chain.length - 1]) closed = true;
		}
		if (closed && chain.length >= 4) rings.push(chain);
	}
	return rings;
}

const greenWays: Way[] = [];
const waterWays: Way[] = [];
const riverWays: Way[] = [];
const transitWays: Way[] = [];
const transitPoints: TransitPoint[] = [];
const greenRelations: GreenRelation[] = [];
const relationMemberWayIds = new Set<number>();
const neededNodes = new Set<number>();

// Pass 1: tagged ways/nodes and green relation definitions.
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
					name: osmName(tags),
					pt: [round(item.lon), round(item.lat)],
				});
			}
			return;
		}
		if (item.type === "relation") {
			if (!isGreenTags(tags)) return;
			const relation = item as RelationItem;
			const outerWayIds: number[] = [];
			for (const member of relation.members ?? []) {
				if (member.type !== "way") continue;
				if (member.role != null && member.role !== "" && member.role !== "outer") {
					continue;
				}
				outerWayIds.push(member.id);
				relationMemberWayIds.add(member.id);
			}
			if (outerWayIds.length === 0) return;
			greenRelations.push({
				id: relation.id,
				kind: greenKind(tags),
				name: osmName(tags),
				outerWayIds,
			});
			return;
		}
		if (item.type !== "way") return;
		const refs = (item.refs ?? []) as number[];
		const way = { id: item.id, refs, tags };
		const isGreen = isGreenTags(tags);
		const isWater =
			tags.natural === "water" ||
			tags.water === "lake" ||
			tags.landuse === "reservoir";
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
			for (const ref of refs) neededNodes.add(ref);
		}
	});
	console.log(`pass 1 done: ${pbfPath}`);
}

// Pass 2: node refs of relation member ways (their geometry is not tagged).
const memberWayRefs = new Map<number, number[]>();
for (const pbfPath of PBF_PATHS) {
	await forEachPbfItem(pbfPath, (item) => {
		if (item.type !== "way" || !relationMemberWayIds.has(item.id)) return;
		const refs = (item.refs ?? []) as number[];
		memberWayRefs.set(item.id, refs);
		for (const ref of refs) neededNodes.add(ref);
	});
	console.log(`pass 2 done: ${pbfPath} (${memberWayRefs.size} member ways)`);
}

// Pass 3: coordinates for every node any emitted geometry needs.
const coords = new Map<number, Coord>();
for (const pbfPath of PBF_PATHS) {
	await forEachPbfItem(pbfPath, (item) => {
		if (
			item.type === "node" &&
			neededNodes.has(item.id) &&
			item.lat != null &&
			item.lon != null
		) {
			coords.set(item.id, [item.lon, item.lat]);
		}
	});
	console.log(`pass 3 done: ${pbfPath} (${coords.size} coords)`);
}

function wayCoords(way: Way): Coord[] {
	const out: Coord[] = [];
	for (const ref of way.refs) {
		const point = coords.get(ref);
		if (point) out.push(point);
	}
	return out;
}

function ringToCoords(refs: readonly number[]): Coord[] | null {
	const out: Coord[] = [];
	for (const ref of refs) {
		const point = coords.get(ref);
		if (!point) return null;
		out.push(point);
	}
	return out;
}

const greenPolygons: GreenPolygon[] = [];
let relationRingsStitched = 0;
let relationRingsDropped = 0;
let relationsWithoutRing = 0;
const coveredByRelation = new Set<number>();

for (const relation of greenRelations) {
	const refLists: number[][] = [];
	for (const wayId of relation.outerWayIds) {
		const refs = memberWayRefs.get(wayId);
		if (refs) refLists.push(refs);
	}
	const rings = stitchRings(refLists);
	if (rings.length === 0) {
		relationsWithoutRing++;
		continue;
	}
	let emitted = 0;
	for (const ring of rings) {
		const ringCoords = ringToCoords(ring);
		if (!ringCoords) {
			relationRingsDropped++;
			continue;
		}
		const points = rdp(ringCoords, GREEN_SIMPLIFY).map(
			([x, y]) => [round(x), round(y)] as Coord,
		);
		if (points.length < 4) {
			relationRingsDropped++;
			continue;
		}
		relationRingsStitched++;
		emitted++;
		greenPolygons.push({
			kind: relation.kind,
			name: relation.name,
			ring: points,
		});
	}
	if (emitted > 0) {
		for (const wayId of relation.outerWayIds) coveredByRelation.add(wayId);
	}
}

for (const way of greenWays) {
	if (coveredByRelation.has(way.id)) continue;
	const points = rdp(wayCoords(way), GREEN_SIMPLIFY).map(
		([x, y]) => [round(x), round(y)] as Coord,
	);
	if (points.length < 4) continue;
	greenPolygons.push({
		kind: greenKind(way.tags),
		name: osmName(way.tags),
		ring: points,
	});
}

const waterPolygons: WaterPolygon[] = [];
for (const way of waterWays) {
	if (coveredByRelation.has(way.id)) continue;
	const points = rdp(wayCoords(way), WATER_SIMPLIFY).map(
		([x, y]) => [round(x), round(y)] as Coord,
	);
	if (points.length < 4) continue;
	waterPolygons.push({ kind: "water", name: osmName(way.tags), ring: points });
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
		transitPoints.push({ kind, name: osmName(way.tags), pt: point });
	}
}

const seen = new Set<string>();
const uniqueTransit = transitPoints.filter((point) => {
	const key = `${point.kind}:${point.pt[0]},${point.pt[1]}`;
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
});

const namedGreen = greenPolygons.filter((polygon) => polygon.name != null).length;
const namedWater = waterPolygons.filter((polygon) => polygon.name != null).length;

const body = `// @ts-nocheck
// Generated by scripts/build-uniqueness-geo.ts from local Geofabrik extracts.
// © OpenStreetMap contributors, ODbL. Regenerate: bun run build:uniqueness
// Tagged ways plus stitched multipolygon relation rings; inner rings are not emitted.

export interface GreenPolygon {
	kind: "park" | "forest";
	name: string | null;
	ring: [number, number][];
}
export const GREEN_POLYGONS: GreenPolygon[] = ${JSON.stringify(greenPolygons)};

export interface WaterPolygon {
	kind: "water";
	name: string | null;
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
console.log(
	`green relations=${greenRelations.length} rings stitched=${relationRingsStitched} ` +
		`rings dropped=${relationRingsDropped} relations without ring=${relationsWithoutRing} ` +
		`named green=${namedGreen} (${((namedGreen / Math.max(1, greenPolygons.length)) * 100).toFixed(1)}%) ` +
		`named water=${namedWater}`,
);
