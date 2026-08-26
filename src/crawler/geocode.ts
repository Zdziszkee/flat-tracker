import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { buildings, listings, transactions } from "#/db/schema";

interface OverpassElement {
	type: string;
	id: number;
	lat?: number;
	lon?: number;
	center?: { lat: number; lon: number };
	tags?: Record<string, string>;
	geometry?: Array<{ lat: number; lon: number }>;
}

const OVERPASS_ENDPOINTS = [
	"https://overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
	"https://overpass.private.coffee/api/interpreter",
];

/** Radius around the point used to fetch candidate building footprints. */
const CONTAIN_RADIUS_M = 30;
/** Fallback: nearest building within this radius if none contains the point. */
const NEAREST_RADIUS_M = 120;

function pointInPolygon(
	lat: number,
	lng: number,
	poly: Array<{ lat: number; lon: number }>,
): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].lon;
		const yi = poly[i].lat;
		const xj = poly[j].lon;
		const yj = poly[j].lat;
		const intersect =
			yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

function haversineMeters(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/** Minimum distance (m) from a point to a polygon's edges. */
function distanceToPolygonMeters(
	lat: number,
	lng: number,
	poly: Array<{ lat: number; lon: number }>,
): number {
	let min = Infinity;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[j];
		const b = poly[i];
		// Closest point on segment AB to P (2D planar approx is fine at city scale).
		const dx = b.lon - a.lon;
		const dy = b.lat - a.lat;
		const len2 = dx * dx + dy * dy;
		let t = len2 === 0 ? 0 : ((lng - a.lon) * dx + (lat - a.lat) * dy) / len2;
		t = Math.max(0, Math.min(1, t));
		const cx = a.lon + t * dx;
		const cy = a.lat + t * dy;
		min = Math.min(min, haversineMeters(lat, lng, cy, cx));
	}
	return min;
}

interface BuildingMatch {
	osmId: number;
	lat: number;
	lng: number;
	address: string | null;
	tags: Record<string, string> | null;
	geometry: Array<{ lat: number; lon: number }> | null;
}

async function queryOverpass(
	query: string,
): Promise<{ elements?: OverpassElement[] }> {
	let lastError: unknown;

	for (const endpoint of OVERPASS_ENDPOINTS) {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const res = await fetch(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						// Overpass rejects generic UAs (curl/node) with 406.
						"user-agent": "flat-tracker/0.1 (personal project)",
					},
					body: `data=${encodeURIComponent(query)}`,
					// Busy public instances can stall; never let a fetch hang.
					signal: AbortSignal.timeout(30_000),
				});
				if (!res.ok)
					throw new Error(`Overpass HTTP ${res.status} from ${endpoint}`);
				const text = await res.text();
				if (text.trimStart().startsWith("<")) {
					// Busy/error page rendered as HTML (e.g. "server too busy").
					throw new Error(`Overpass HTML error response from ${endpoint}`);
				}
				return JSON.parse(text) as { elements?: OverpassElement[] };
			} catch (err) {
				lastError = err;
				await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
			}
		}
	}
	throw lastError;
}

function elementPoint(el: OverpassElement): { lat: number; lon: number } {
	const c = el.center;
	if (
		c &&
		typeof c.lat === "number" &&
		typeof c.lon === "number" &&
		Number.isFinite(c.lat) &&
		Number.isFinite(c.lon)
	) {
		return c;
	}
	if (el.lat !== undefined && el.lon !== undefined)
		return { lat: el.lat, lon: el.lon };
	// Compute a rough centroid from the geometry ring.
	if (el.geometry && el.geometry.length > 0) {
		let lat = 0;
		let lon = 0;
		for (const p of el.geometry) {
			lat += p.lat;
			lon += p.lon;
		}
		return { lat: lat / el.geometry.length, lon: lon / el.geometry.length };
	}
	return { lat: 0, lon: 0 };
}

function matchPoint(
	lat: number,
	lng: number,
	elements: OverpassElement[],
): BuildingMatch | null {
	const contained: BuildingMatch[] = [];
	for (const el of elements) {
		if (el.geometry && el.geometry.length > 2) {
			const within = pointInPolygon(lat, lng, el.geometry);
			const distance = distanceToPolygonMeters(lat, lng, el.geometry);
			if (within || distance < CONTAIN_RADIUS_M) {
				const c = elementPoint(el);
				contained.push({
					osmId: el.id,
					lat: c.lat,
					lng: c.lon,
					address: formatAddress(el.tags),
					tags: el.tags ?? null,
					geometry: el.geometry,
				});
			}
		}
	}
	if (contained.length > 0) {
		contained.sort((a, b) => {
			const ad = haversineMeters(lat, lng, a.lat, a.lng);
			const bd = haversineMeters(lat, lng, b.lat, b.lng);
			return ad - bd;
		});
		return contained[0];
	}

	let nearest: OverpassElement | null = null;
	let best = Infinity;
	for (const el of elements) {
		const c = elementPoint(el);
		const d = haversineMeters(lat, lng, c.lat, c.lon);
		if (d < best) {
			best = d;
			nearest = el;
		}
	}
	if (!nearest) return null;

	const c = elementPoint(nearest);
	return {
		osmId: nearest.id,
		lat: c.lat,
		lng: c.lon,
		address: formatAddress(nearest.tags),
		tags: nearest.tags ?? null,
		geometry: nearest.geometry ?? null,
	};
}

/**
 * Find the OSM building that contains the given point, by querying Overpass
 * for building footprints nearby and testing point-in-polygon. Falls back to
 * the nearest building within ~120 m when no polygon contains the point
 * (portal coordinates are approximate).
 */
export async function findBuilding(
	lat: number,
	lng: number,
): Promise<BuildingMatch | null> {
	// Reject implausible coordinates early (Krakow bounding box).
	if (lat < 49.9 || lat > 50.2 || lng < 19.7 || lng > 20.3) return null;

	const query = `[out:json][timeout:30];
(
  way["building"](around:${NEAREST_RADIUS_M},${lat},${lng});
  relation["building"](around:${NEAREST_RADIUS_M},${lat},${lng});
);
out tags center geom;`;

	const json = await queryOverpass(query);
	return matchPoint(lat, lng, json.elements ?? []);
}

/**
 * Batch variant: one Overpass request per `batchSize` points, fanned out
 * across the mirror endpoints in parallel. Transaction points come from
 * RCN georeferencja (already inside the building), so matching by nearest
 * building center within CONTAIN_RADIUS_M is sufficient and avoids
 * shipping heavy geometry per request.
 */
export async function findBuildingsBatch(
	points: Array<{ lat: number; lng: number }>,
	batchSize = 25,
	parallel = 2,
): Promise<Array<BuildingMatch | null>> {
	const results: Array<BuildingMatch | null> = new Array(points.length).fill(
		null,
	);

	const total = Math.ceil(points.length / batchSize);
	let next = 0;
	let done = 0;

	async function worker(endpoint: string): Promise<void> {
		while (true) {
			const i = next;
			next += batchSize;
			if (i >= points.length) return;

			const slice = points.slice(i, i + batchSize);
			// Ways only: apartment buildings are almost always OSM ways.
			// 60 m fetch radius is enough to find the containing building and
			// keeps the response small enough to avoid 429s/timeouts.
			const around = slice
				.map((p) => `way["building"](around:60,${p.lat},${p.lng});`)
				.join("\n");
			const query = `[out:json][timeout:30];
(
${around}
);
out tags center;`;

			console.log(
				`[${endpoint.replace("https://", "")}] Overpass batch ${i / batchSize + 1}/${total} (${slice.length} points)...`,
			);

			let elements: OverpassElement[] = [];
			let succeeded = false;
			for (let attempt = 0; attempt < 3 && !succeeded; attempt++) {
				try {
					const json = await queryOverpassWith(endpoint, query);
					elements = json.elements ?? [];
					succeeded = true;
				} catch (err) {
					console.warn(
						`Overpass batch ${i / batchSize + 1} attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
				}
			}
			if (!succeeded) {
				console.warn(`Overpass batch ${i / batchSize + 1} giving up, skipping`);
			}

			for (let j = 0; j < slice.length; j++) {
				const p = slice[j];
				if (p.lat < 49.9 || p.lat > 50.2 || p.lng < 19.7 || p.lng > 20.3)
					continue;
				results[i + j] = matchByCenter(p.lat, p.lng, elements);
			}

			done++;
			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	await Promise.all(OVERPASS_ENDPOINTS.slice(0, parallel).map(worker));
	console.log(`Overpass: ${done}/${total} batches done`);
	return results;
}

/** Nearest building whose center is within CONTAIN_RADIUS_M of the point. */
function matchByCenter(
	lat: number,
	lng: number,
	elements: OverpassElement[],
): BuildingMatch | null {
	let best: OverpassElement | null = null;
	let bestDist = CONTAIN_RADIUS_M;
	for (const el of elements) {
		if (el.type !== "way" && el.type !== "relation") continue;
		const c = elementPoint(el);
		if (c.lat === 0 && c.lon === 0) continue;
		const d = haversineMeters(lat, lng, c.lat, c.lon);
		if (d < bestDist) {
			bestDist = d;
			best = el;
		}
	}
	if (!best) return null;
	const c = elementPoint(best);
	return {
		osmId: best.id,
		lat: c.lat,
		lng: c.lon,
		address: formatAddress(best.tags),
		tags: best.tags ?? null,
		geometry: null,
	};
}

async function queryOverpassWith(
	endpoint: string,
	query: string,
): Promise<{ elements?: OverpassElement[] }> {
	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"user-agent": "flat-tracker/0.1 (personal project)",
		},
		body: `data=${encodeURIComponent(query)}`,
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new Error(`Overpass HTTP ${res.status} from ${endpoint}`);
	const text = await res.text();
	if (text.trimStart().startsWith("<")) {
		throw new Error(`Overpass HTML error response from ${endpoint}`);
	}
	return JSON.parse(text) as { elements?: OverpassElement[] };
}

function formatAddress(
	tags: Record<string, string> | undefined,
): string | null {
	if (!tags) return null;
	const street = tags["addr:street"];
	const number = tags["addr:housenumber"];
	if (!street && !number) return null;
	return [street, number].filter(Boolean).join(" ");
}

/**
 * Assign a building to one point: returns the existing building id from the
 * DB, or fetches from Overpass and persists a new building row.
 */
export async function assignBuilding(
	lat: number,
	lng: number,
): Promise<number | null> {
	const match = await findBuilding(lat, lng);
	if (!match) return null;
	return upsertBuilding(match);
}

async function upsertBuilding(match: BuildingMatch): Promise<number | null> {
	const existing = await db.query.buildings.findFirst({
		where: (b) => eq(b.osmId, match.osmId),
	});
	if (existing) return existing.id;

	const [row] = await db
		.insert(buildings)
		.values({
			osmId: match.osmId,
			lat: match.lat,
			lng: match.lng,
			address: match.address,
			tags: match.tags ? JSON.stringify(match.tags) : null,
			geometry: match.geometry ? JSON.stringify(match.geometry) : null,
		})
		.onConflictDoNothing()
		.returning({ id: buildings.id });

	return row?.id ?? null;
}

/**
 * Resolve matches to building ids, inserting unknown buildings in bulk.
 * `existingOsmIds` is mutated to keep track of buildings seen this run.
 */
async function resolveBuildingIds(
	matches: Array<BuildingMatch | null>,
	existingOsmIds: Set<number>,
): Promise<Array<number | null>> {
	const ids: Array<number | null> = new Array(matches.length).fill(null);
	const toInsert: BuildingMatch[] = [];

	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		if (!m) continue;
		if (existingOsmIds.has(m.osmId)) continue;
		existingOsmIds.add(m.osmId);
		toInsert.push(m);
	}

	// Bulk insert new buildings, then map osmId -> row id.
	const osmToId = new Map<number, number>();
	if (toInsert.length > 0) {
		const inserted = await db
			.insert(buildings)
			.values(
				toInsert.map((m) => ({
					osmId: m.osmId,
					lat: m.lat,
					lng: m.lng,
					address: m.address,
					tags: m.tags ? JSON.stringify(m.tags) : null,
					geometry: m.geometry ? JSON.stringify(m.geometry) : null,
				})),
			)
			.onConflictDoNothing()
			.returning({ id: buildings.id, osmId: buildings.osmId });

		for (const r of inserted) osmToId.set(r.osmId, r.id);
	}

	// Pre-fetch ids for buildings that already existed.
	const known = await db
		.select({ id: buildings.id, osmId: buildings.osmId })
		.from(buildings)
		.where(inArray(buildings.osmId, [...existingOsmIds]));

	for (const r of known) osmToId.set(r.osmId, r.id);

	for (let i = 0; i < matches.length; i++) {
		const m = matches[i];
		if (!m) continue;
		ids[i] = osmToId.get(m.osmId) ?? null;
	}
	return ids;
}

/** Assign buildings to all listings that have coordinates but no building. */
export async function assignBuildingsToListings(): Promise<number> {
	const unassigned = await db
		.select({ id: listings.id, lat: listings.lat, lng: listings.lng })
		.from(listings)
		.where(and(isNull(listings.buildingId), isNotNull(listings.lat)));

	const points = unassigned
		.filter((l) => l.lat !== null && l.lng !== null)
		.map((l) => ({ lat: l.lat as number, lng: l.lng as number }));

	const matches = await findBuildingsBatch(points);

	const existing = await db.select({ osmId: buildings.osmId }).from(buildings);
	const existingOsmIds = new Set(existing.map((b) => b.osmId));
	const ids = await resolveBuildingIds(matches, existingOsmIds);

	let assigned = 0;
	for (let i = 0; i < unassigned.length; i++) {
		const id = ids[i];
		if (id === null) continue;
		await db
			.update(listings)
			.set({ buildingId: id })
			.where(eq(listings.id, unassigned[i].id));
		assigned++;
	}
	return assigned;
}

/** Same as above, for historical RCN transactions. */
export async function assignBuildingsToTransactions(): Promise<number> {
	const unassigned = await db
		.select({
			id: transactions.id,
			lat: transactions.lat,
			lng: transactions.lng,
		})
		.from(transactions)
		.where(and(isNull(transactions.buildingId), isNotNull(transactions.lat)));

	const points = unassigned
		.filter((t) => t.lat !== null && t.lng !== null)
		.map((t) => ({ lat: t.lat as number, lng: t.lng as number }));

	// Transactions in the same building share a georeferenced point, so
	// dedupe by ~11 m buckets and query Overpass once per unique point.
	const bucketOf = (p: { lat: number; lng: number }): string =>
		`${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
	const buckets = new Map<string, number[]>();
	for (let i = 0; i < points.length; i++) {
		const key = bucketOf(points[i]);
		const list = buckets.get(key);
		if (list) list.push(i);
		else buckets.set(key, [i]);
	}
	const uniquePoints = [...buckets.keys()].map((key) => {
		const [lat, lng] = key.split(",").map(Number);
		return { lat, lng };
	});
	console.log(
		`tx to assign: ${points.length}, unique points: ${uniquePoints.length}`,
	);

	const matches = await findBuildingsBatch(uniquePoints);

	const existing = await db.select({ osmId: buildings.osmId }).from(buildings);
	const existingOsmIds = new Set(existing.map((b) => b.osmId));
	const ids = await resolveBuildingIds(matches, existingOsmIds);

	// Map each unique point's building back to every transaction in its bucket.
	const txBuildingIds: Array<number | null> = new Array(points.length).fill(
		null,
	);
	let u = 0;
	for (const key of buckets.keys()) {
		for (const idx of buckets.get(key) ?? []) {
			txBuildingIds[idx] = ids[u];
		}
		u++;
	}

	let assigned = 0;
	for (let i = 0; i < unassigned.length; i++) {
		const id = txBuildingIds[i];
		if (id === null) continue;
		await db
			.update(transactions)
			.set({ buildingId: id })
			.where(eq(transactions.id, unassigned[i].id));
		assigned++;
	}
	return assigned;
}
