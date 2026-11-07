/**
 * Local OSM proximity evidence for the uniqueness score.
 *
 * Distances are computed against simplified way geometry with an RBush
 * prefilter, not from a text guess. Multipolygon relations and elevation are
 * not modelled; callers see the resulting distances and can judge the
 * evidence directly.
 */

import RBush from "rbush";

import { EXTERNAL_CITIES } from "#/lib/valuation/external-city";

interface IndexItem {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	coords?: Array<[number, number]>;
	pt?: [number, number];
	kind?: string;
}

interface Indexes {
	green: RBush<IndexItem>;
	water: RBush<IndexItem>;
	river: RBush<IndexItem>;
	rail: RBush<IndexItem>;
	transit: RBush<IndexItem>;
	stations: RBush<IndexItem>;
}

export interface GeoUniqueness {
	parkM: number | null;
	forestM: number | null;
	waterM: number | null;
	riverM: number | null;
	railM: number | null;
	trainStationM: number | null;
	transitM: number | null;
	city: string | null;
	centerM: number | null;
	source: "osm-ways";
}

let indexesPromise: Promise<Indexes> | null = null;

function bboxOf(coords: readonly [number, number][]): IndexItem | null {
	if (coords.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of coords) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	return { minX, minY, maxX, maxY, coords: [...coords] };
}

function pointItem(pt: [number, number], kind: string): IndexItem {
	return { minX: pt[0], minY: pt[1], maxX: pt[0], maxY: pt[1], pt, kind };
}

function loadTree(items: IndexItem[]): RBush<IndexItem> {
	const tree = new RBush<IndexItem>();
	tree.load(items.filter((item) => item != null));
	return tree;
}

async function getIndexes(): Promise<Indexes> {
	if (!indexesPromise) {
		indexesPromise = (async () => {
			const [uniqueness, railways] = await Promise.all([
				import("#/data/region-uniqueness"),
				import("#/data/region-railways"),
			]);
			const green = uniqueness.GREEN_POLYGONS.flatMap((polygon) => {
				const item = bboxOf(polygon.ring);
				return item ? [{ ...item, kind: polygon.kind }] : [];
			});
			const water = uniqueness.WATER_POLYGONS.flatMap((polygon) => {
				const item = bboxOf(polygon.ring);
				return item ? [{ ...item, kind: polygon.kind }] : [];
			});
			const river = uniqueness.RIVER_LINES.flatMap((line) => {
				const item = bboxOf(line.points);
				return item ? [{ ...item, kind: line.kind }] : [];
			});
			const rail = railways.RAIL_LINES.flatMap((line) => {
				const item = bboxOf(line);
				return item ? [{ ...item, kind: "rail" }] : [];
			});
			const transit = uniqueness.TRANSIT_POINTS.map((point) =>
				pointItem(point.pt, point.kind),
			);
			const stations = railways.RAIL_STATIONS.map((station) =>
				pointItem(station.pt, "train"),
			);
			return {
				green: loadTree(green),
				water: loadTree(water),
				river: loadTree(river),
				rail: loadTree(rail),
				transit: loadTree(transit),
				stations: loadTree(stations),
			};
		})();
	}
	return indexesPromise;
}

function haversineM(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number,
): number {
	const rad = Math.PI / 180;
	const dLat = (lat2 - lat1) * rad;
	const dLng = (lng2 - lng1) * rad;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function pointInRing(lng: number, lat: number, ring: readonly [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const a = ring[i];
		const b = ring[j];
		if (!a || !b) continue;
		const intersects =
			a[1] > lat !== b[1] > lat &&
			lng < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0];
		if (intersects) inside = !inside;
	}
	return inside;
}

function segmentDistanceM(
	lng: number,
	lat: number,
	a: readonly [number, number],
	b: readonly [number, number],
): number {
	const scaleX = 111320 * Math.cos((lat * Math.PI) / 180);
	const scaleY = 111320;
	const px = 0;
	const py = 0;
	const ax = (a[0] - lng) * scaleX;
	const ay = (a[1] - lat) * scaleY;
	const bx = (b[0] - lng) * scaleX;
	const by = (b[1] - lat) * scaleY;
	const dx = bx - ax;
	const dy = by - ay;
	const lengthSq = dx * dx + dy * dy;
	if (lengthSq === 0) return Math.hypot(ax, ay);
	const t = Math.max(
		0,
		Math.min(1, (px * dx + py * dy - ax * dx - ay * dy) / lengthSq),
	);
	return Math.hypot(ax + t * dx, ay + t * dy);
}

function lineDistanceM(
	lng: number,
	lat: number,
	coords: readonly [number, number][],
	closed: boolean,
): number {
	if (coords.length === 0) return Number.POSITIVE_INFINITY;
	let best = Number.POSITIVE_INFINITY;
	const count = closed ? coords.length : coords.length - 1;
	for (let i = 0; i < count; i++) {
		const a = coords[i];
		const b = coords[(i + 1) % coords.length];
		if (!a || !b) continue;
		best = Math.min(best, segmentDistanceM(lng, lat, a, b));
	}
	return best;
}

function candidates(
	tree: RBush<IndexItem>,
	lng: number,
	lat: number,
	maxM: number,
): IndexItem[] {
	const dLat = maxM / 111320;
	const dLng = maxM / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
	return tree.search({
		minX: lng - dLng,
		minY: lat - dLat,
		maxX: lng + dLng,
		maxY: lat + dLat,
	});
}

function nearestGeometry(
	tree: RBush<IndexItem>,
	lng: number,
	lat: number,
	maxM: number,
	closed: boolean,
	kind?: string,
): number | null {
	let best = Number.POSITIVE_INFINITY;
	for (const item of candidates(tree, lng, lat, maxM)) {
		if (kind && item.kind !== kind) continue;
		if (!item.coords) continue;
		const distance = lineDistanceM(lng, lat, item.coords, closed);
		best = Math.min(best, distance);
	}
	return Number.isFinite(best) ? best : null;
}

function nearestPoint(
	tree: RBush<IndexItem>,
	lng: number,
	lat: number,
	maxM: number,
	kind?: string,
): number | null {
	let best = Number.POSITIVE_INFINITY;
	for (const item of candidates(tree, lng, lat, maxM)) {
		if (kind && item.kind !== kind) continue;
		if (!item.pt) continue;
		best = Math.min(best, haversineM(lat, lng, item.pt[1], item.pt[0]));
	}
	return Number.isFinite(best) ? best : null;
}

function nearestPolygon(
	tree: RBush<IndexItem>,
	lng: number,
	lat: number,
	maxM: number,
	kind?: string,
): number | null {
	let best = Number.POSITIVE_INFINITY;
	for (const item of candidates(tree, lng, lat, maxM)) {
		if (kind && item.kind !== kind) continue;
		if (!item.coords) continue;
		const distance = pointInRing(lng, lat, item.coords)
			? 0
			: lineDistanceM(lng, lat, item.coords, true);
		best = Math.min(best, distance);
	}
	return Number.isFinite(best) ? best : null;
}

export async function geoUniqueness(
	lat: number | null,
	lng: number | null,
): Promise<GeoUniqueness | null> {
	if (lat == null || lng == null) return null;
	const indexes = await getIndexes();
	let city: string | null = null;
	let centerM: number | null = null;
	for (const candidate of EXTERNAL_CITIES) {
		const distance = haversineM(lat, lng, candidate.lat, candidate.lng);
		if (centerM == null || distance < centerM) {
			city = candidate.slug;
			centerM = distance;
		}
	}
	return {
		parkM: nearestPolygon(indexes.green, lng, lat, 3000, "park"),
		forestM: nearestPolygon(indexes.green, lng, lat, 3000, "forest"),
		waterM: nearestPolygon(indexes.water, lng, lat, 3000),
		riverM: nearestGeometry(indexes.river, lng, lat, 3000, false),
		railM: nearestGeometry(indexes.rail, lng, lat, 2000, false),
		trainStationM: nearestPoint(indexes.stations, lng, lat, 5000),
		transitM: nearestPoint(indexes.transit, lng, lat, 3000),
		city,
		centerM,
		source: "osm-ways",
	};
}
