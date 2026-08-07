import { and, eq, isNotNull, isNull } from "drizzle-orm";

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
 * Batch variant: one Overpass request for up to `batchSize` points, each
 * matched to the nearest building from the combined result set. This keeps
 * the free API happy while assigning hundreds of listings quickly.
 */
export async function findBuildingsBatch(
	points: Array<{ lat: number; lng: number }>,
	batchSize = 20,
): Promise<Array<BuildingMatch | null>> {
	const results: Array<BuildingMatch | null> = new Array(points.length).fill(
		null,
	);

	for (let i = 0; i < points.length; i += batchSize) {
		const slice = points.slice(i, i + batchSize);
		const around = slice
			.map(
				(p) => `way["building"](around:${NEAREST_RADIUS_M},${p.lat},${p.lng});`,
			)
			.join("\n");
		const query = `[out:json][timeout:60];
(
${around}
);
out tags center geom;`;

		console.log(
			`Overpass batch ${i / batchSize + 1}/${Math.ceil(points.length / batchSize)} (${slice.length} points)...`,
		);

		let elements: OverpassElement[] = [];
		try {
			const json = await queryOverpass(query);
			elements = json.elements ?? [];
		} catch {
			// One failed batch leaves those points unassigned; they can be
			// retried with `npm run assign-buildings`.
			console.warn(`Overpass batch ${i / batchSize + 1} failed, skipping`);
		}

		for (let j = 0; j < slice.length; j++) {
			const p = slice[j];
			if (p.lat < 49.9 || p.lat > 50.2 || p.lng < 19.7 || p.lng > 20.3)
				continue;
			results[i + j] = matchPoint(p.lat, p.lng, elements);
		}

		await new Promise((r) => setTimeout(r, 1200));
	}

	return results;
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

	let assigned = 0;
	for (let i = 0; i < unassigned.length; i++) {
		const l = unassigned[i];
		const match = matches[i];
		if (!match) continue;
		const buildingId = await upsertBuilding(match);
		if (buildingId !== null) {
			await db
				.update(listings)
				.set({ buildingId })
				.where(eq(listings.id, l.id));
			assigned++;
		}
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

	const matches = await findBuildingsBatch(points);

	let assigned = 0;
	for (let i = 0; i < unassigned.length; i++) {
		const t = unassigned[i];
		const match = matches[i];
		if (!match) continue;
		const buildingId = await upsertBuilding(match);
		if (buildingId !== null) {
			await db
				.update(transactions)
				.set({ buildingId })
				.where(eq(transactions.id, t.id));
			assigned++;
		}
	}
	return assigned;
}
