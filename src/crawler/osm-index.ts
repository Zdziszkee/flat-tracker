import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq, gt, sql } from "drizzle-orm";

import osmPbf, { type OsmItem } from "osm-pbf-parser";
import RBush from "rbush";

import { db } from "#/db/index";
import { TRACKED_REGIONS, type TrackedRegion } from "#/db/region";
import { osmBuildings } from "#/db/schema";
import { invalidateAddressIndex } from "./address-index.ts";

/**
 * Local OSM building index for every tracked region (małopolskie + śląskie).
 *
 * The public Overpass API is too rate-limited for assigning ~84k RCN
 * transactions to buildings, so this module downloads one Geofabrik
 * extract per tracked voivodeship, streams each PBF with osm-pbf-parser,
 * keeps every building footprint, and stores them in the `osm_buildings`
 * table in a single indexing pass. Matching is then a local
 * point-in-polygon query via an in-memory RBush, with zero network
 * dependency.
 *
 * Regions are indexed per file and concatenated: Geofabrik extracts carry
 * complete ways and relations at their boundaries, so a building that
 * straddles the małopolskie/śląskie border has all of its nodes in both
 * extracts, and OSM ids are global, so the two files cannot collide. Peak
 * memory stays one extract's worth because each file's node/way maps are
 * discarded before the next one starts.
 *
 * Region-wide coverage matters for sources that span the whole voivodeship
 * (booking, airbnb: Zakopane, Oświęcim, Szczawnica...). Cross-town street
 * name collisions are handled downstream: address matching is guarded by
 * city hints (address-index.ts) and, for georeferenced records, by a
 * max-distance check against the record's own coordinates.
 */

const DATA_DIR = "data/osm";

/**
 * One Geofabrik extract per tracked voivodeship. The keys are the source of
 * truth for "which regions is the index built from" (the build marker
 * below), and they mirror `TRACKED_REGIONS` — a region added there without
 * a PBF here means its parcels/building history can never be anchored, so
 * `buildOsmIndex` says so instead of silently indexing less.
 */
export const OSM_REGIONS = ["malopolskie", "slaskie"] as const;
export type OsmRegion = (typeof OSM_REGIONS)[number];

const GEOFABRIK_BASE = "https://download.geofabrik.de/europe/poland";

const PBF_SOURCES: Array<{ region: OsmRegion; url: string; path: string }> =
	OSM_REGIONS.map((region) => ({
		region,
		url: `${GEOFABRIK_BASE}/${region}-latest.osm.pbf`,
		path: `${DATA_DIR}/${region}.osm.pbf`,
	}));

/**
 * Which regions the rows in `osm_buildings` were built from. Adding a
 * region must rebuild the table (it is a full rebuild, not a merge), and
 * the table itself cannot say what built it, so the marker does: an index
 * built before this file existed / with fewer regions reports "not ready".
 */
const BUILD_STATE_PATH = `${DATA_DIR}/build-state.json`;

interface OsmBuildState {
	regions: string[];
	builtAt?: string;
}

export interface OsmBuilding {
	osmId: number;
	bboxMinLat: number;
	bboxMinLng: number;
	bboxMaxLat: number;
	bboxMaxLng: number;
	centroidLat: number;
	centroidLng: number;
	polygon: Array<{ lat: number; lng: number }>;
	address: string | null;
	tags: Record<string, string> | null;
}

function centroid(ring: Array<{ lat: number; lng: number }>): {
	lat: number;
	lng: number;
} {
	let lat = 0;
	let lng = 0;
	for (const p of ring) {
		lat += p.lat;
		lng += p.lng;
	}
	return { lat: lat / ring.length, lng: lng / ring.length };
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

/** Download every extract that is not cached yet (each ~200 MB). */
async function downloadIfMissing(): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true });
	for (const source of PBF_SOURCES) {
		try {
			await stat(source.path);
			console.log(`Using cached ${source.path}`);
			continue;
		} catch {
			// fall through
		}
		console.log(`Downloading ${source.url} ...`);
		const res = await fetch(source.url, {
			signal: AbortSignal.timeout(600_000),
		});
		if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
		await pipeline(
			Readable.fromWeb(res.body as never),
			createWriteStream(source.path),
		);
	}
}

/** Heap in use, for the rebuild's progress lines (it runs in-process). */
function heapMb(): number {
	return Math.round(process.memoryUsage().heapUsed / 1e6);
}

/**
 * Stream one extract, collect every building way, resolve polygons, and hand
 * each finished batch to `onBatch`.
 *
 * Called per region, never with two files in flight, and deliberately
 * frugal: this runs inside the server process (assign-buildings is called by
 * the hourly refresh), where the default V8 heap is ~4.4 GB and two
 * voivodeships of OSM data do not fit as objects. The nodes, which are the
 * bulk (an extract references ~9M of them), live in one flat Float64Array
 * addressed by a single Map — the previous `Set<needed>` plus
 * `Map<id, {lat, lng}>` cost over a gigabyte per region and OOMed on the
 * second one. Each building is also dropped from `ways` as soon as its ring
 * is emitted, so the way/tag objects shrink as the pass proceeds.
 */
async function extractBuildingsFromPbf(
	pbfPath: string,
	onBatch: (batch: OsmBuilding[]) => Promise<number>,
): Promise<number> {
	// Pass 1: collect all building ways (id, refs, tags) in the region.
	const ways = new Map<
		number,
		{ refs: number[]; tags: Record<string, string> }
	>();

	await new Promise<void>((resolve, reject) => {
		const osm = osmPbf();
		osm.on("data", (items: OsmItem[]) => {
			for (const item of items) {
				if (item.type !== "way") continue;
				const tags = (item.tags ?? {}) as Record<string, string>;
				if (!tags.building) continue;
				const refs = (item.refs ?? []) as number[];
				if (refs.length < 3) continue;
				ways.set(item.id as number, { refs, tags });
			}
		});
		osm.on("end", resolve);
		osm.on("error", reject);
		createReadStream(pbfPath).pipe(osm);
	});

	console.log(
		`building ways in ${pbfPath}: ${ways.size} (heap ${heapMb()} MB)`,
	);

	// Pass 2: collect coordinates for every referenced node. The extract is
	// voivodeship-wide, so no geographic filtering is needed here. `slots`
	// doubles as the "is this node referenced" test: -1 means referenced but
	// not seen yet, >= 0 is a slot index into `coords`.
	const slots = new Map<number, number>();
	for (const w of ways.values()) {
		for (const ref of w.refs) {
			slots.set(ref, -1);
		}
	}
	let coords = new Float64Array(1 << 21); // grows by doubling (~2M nodes)
	let nodeCount = 0;

	await new Promise<void>((resolve, reject) => {
		const osm = osmPbf();
		osm.on("data", (items: OsmItem[]) => {
			for (const item of items) {
				if (item.type !== "node") continue;
				const id = item.id as number;
				if (slots.get(id) !== -1) continue;
				if (nodeCount * 2 + 2 > coords.length) {
					const grown = new Float64Array(coords.length * 2);
					grown.set(coords);
					coords = grown;
				}
				coords[nodeCount * 2] = item.lat as number;
				coords[nodeCount * 2 + 1] = item.lon as number;
				slots.set(id, nodeCount);
				nodeCount++;
			}
		});
		osm.on("end", resolve);
		osm.on("error", reject);
		createReadStream(pbfPath).pipe(osm);
	});

	console.log(
		`node coords kept in ${pbfPath}: ${nodeCount} (heap ${heapMb()} MB)`,
	);

	// Build polygons and emit them in batches (with unresolved refs, i.e.
	// clipped at the extract edge, skipped). Emitting as we go is what keeps
	// a region's worth of rings and tag objects out of the heap: each way is
	// dropped once its building is handed over.
	const BATCH = 2000;
	let batch: OsmBuilding[] = [];
	let found = 0;
	let inserted = 0;
	for (const [osmId, way] of ways) {
		const ring: Array<{ lat: number; lng: number }> = [];
		let complete = true;
		for (const ref of way.refs) {
			const slot = slots.get(ref);
			if (slot === undefined || slot < 0) {
				complete = false;
				break;
			}
			ring.push({
				lat: coords[slot * 2],
				lng: coords[slot * 2 + 1],
			});
		}
		ways.delete(osmId);
		if (!complete || ring.length < 3) continue;

		const c = centroid(ring);
		let minLat = Infinity;
		let minLng = Infinity;
		let maxLat = -Infinity;
		let maxLng = -Infinity;
		for (const p of ring) {
			minLat = Math.min(minLat, p.lat);
			minLng = Math.min(minLng, p.lng);
			maxLat = Math.max(maxLat, p.lat);
			maxLng = Math.max(maxLng, p.lng);
		}
		batch.push({
			osmId,
			bboxMinLat: minLat,
			bboxMinLng: minLng,
			bboxMaxLat: maxLat,
			bboxMaxLng: maxLng,
			centroidLat: c.lat,
			centroidLng: c.lng,
			polygon: ring,
			address: formatAddress(way.tags),
			tags: way.tags,
		});
		if (batch.length >= BATCH) {
			found += batch.length;
			inserted += await onBatch(batch);
			batch = [];
		}
	}
	if (batch.length > 0) {
		found += batch.length;
		inserted += await onBatch(batch);
	}

	console.log(
		`buildings from ${pbfPath}: found ${found}, inserted ${inserted} ` +
			`(heap ${heapMb()} MB)`,
	);
	return inserted;
}

/** Write which regions the current `osm_buildings` rows came from. */
async function saveBuildState(builtAt: Date): Promise<void> {
	const state: OsmBuildState = {
		regions: [...OSM_REGIONS],
		builtAt: builtAt.toISOString(),
	};
	await writeFile(BUILD_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Marker of the last `buildOsmIndex` run, or null when there is none (an
 * index built before this marker existed, or on another machine).
 */
async function readBuildState(): Promise<OsmBuildState | null> {
	try {
		return JSON.parse(
			await readFile(BUILD_STATE_PATH, "utf8"),
		) as OsmBuildState;
	} catch {
		return null;
	}
}

/**
 * Download every extract, parse each, and (re)build the whole
 * `osm_buildings` table in one pass. A full rebuild on purpose: the table
 * is a bounded local index, and a region added to `OSM_REGIONS` has to
 * replace the old rows rather than merge with them (deleting by region is
 * impossible — a footprint row does not record which extract it came from).
 */
export async function buildOsmIndex(): Promise<number> {
	await downloadIfMissing();

	const tracked = Object.keys(TRACKED_REGIONS) as TrackedRegion[];
	const missing = tracked.filter(
		(region) => !(OSM_REGIONS as readonly string[]).includes(region),
	);
	if (missing.length > 0) {
		console.warn(
			`[osm] tracked region(s) ${missing.join(", ")} have no Geofabrik extract in OSM_REGIONS; ` +
				"their parcels and transactions can never be anchored to a building",
		);
	}

	await db.delete(osmBuildings);
	let total = 0;
	/**
	 * Insert one extracted batch, returning the rows that were actually new.
	 * A building whose footprint straddles the małopolskie/śląskie border is
	 * in BOTH extracts (Geofabrik keeps ways complete at its boundaries), so
	 * the same osm id arrives twice; `osm_id` is unique, so the second copy
	 * is ignored instead of aborting the rebuild halfway.
	 */
	const insertBatch = async (batch: OsmBuilding[]): Promise<number> => {
		const rows = await db
			.insert(osmBuildings)
			.values(
				batch.map((b) => ({
					osmId: b.osmId,
					bboxMinLat: b.bboxMinLat,
					bboxMinLng: b.bboxMinLng,
					bboxMaxLat: b.bboxMaxLat,
					bboxMaxLng: b.bboxMaxLng,
					centroidLat: b.centroidLat,
					centroidLng: b.centroidLng,
					polygon: JSON.stringify(b.polygon),
					address: b.address,
					tags: b.tags ? JSON.stringify(b.tags) : null,
				})),
			)
			.onConflictDoNothing()
			.returning({ id: osmBuildings.id });
		return rows.length;
	};

	// One extract at a time, rows written as they are resolved: a region's
	// buildings are ~1.6M objects with their rings and tag objects, and the
	// next extract must fit in the same heap (see extractBuildingsFromPbf).
	for (const source of PBF_SOURCES) {
		const written = await extractBuildingsFromPbf(source.path, insertBatch);
		console.log(`  ${source.region}: ${written} buildings inserted`);
		total += written;
	}
	await saveBuildState(new Date());
	// The memoized street/city lookups were derived from the rows just
	// replaced; drop them so the next refresh sees the new footprints.
	invalidateAddressIndex();
	console.log(`osm_buildings: ${total} rows inserted`);
	return total;
}

/**
 * A match-ready building. Deliberately not `OsmBuilding`: ~3.2M of these are
 * resident (every footprint of both voivodeships), and the rebuild AND the
 * assignment run inside the server process, whose default V8 heap is 4.4 GB.
 * Measured on dev.db, one object + one Float64Array per footprint peaked at
 * 3.9 GB, which is no margin at all, so:
 *
 *   - rings live in ONE shared Float64Array (`rings`), each building keeping
 *     an offset + point count. A typed array per footprint costs ~320 B of
 *     object/buffer overhead for ~10 points; 3.2M of them are ~1 GB.
 *   - `polygon` and `tags` stay in the DB and are read only when a building is
 *     first inserted into `buildings` (`osmBuildingDetails`).
 */
export interface IndexedBuilding {
	id: number;
	osmId: number;
	centroidLat: number;
	centroidLng: number;
	/** Index of this building's first coordinate in the shared `rings`. */
	ringOffset: number;
	/** Number of points (pairs) in its ring. */
	ringPoints: number;
	address: string | null;
	// RBush's own box fields (x = lng, y = lat), doubling as the footprint bbox.
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * All rings of the loaded index, `[lat, lng, lat, lng, ...]` back to back.
 * Lives next to the tree because `IndexedBuilding.ringOffset` indexes into it.
 */
let rings: Float64Array = new Float64Array(0);
let cached: RBush<IndexedBuilding> | null = null;

/**
 * Load the local index from the DB (cached in memory for the process).
 * Rows are read in pages: `select()` over 3.2M rows materialises every row
 * object plus a full item array before the tree exists, which was ~600 MB of
 * short-lived garbage on top of the tree itself.
 */
export async function loadOsmIndex(): Promise<RBush<IndexedBuilding>> {
	if (cached) return cached;
	const tree = new RBush<IndexedBuilding>();

	// One exact sizing query beats growing a 280 MB array by doubling.
	const [size] = await db
		.select({
			points: sql<number>`coalesce(sum(json_array_length(${osmBuildings.polygon})), 0)`,
		})
		.from(osmBuildings);
	rings = new Float64Array(Number(size?.points ?? 0) * 2);

	const PAGE = 50_000;
	let cursor = 0;
	let used = 0;
	let count = 0;
	for (;;) {
		const rows = await db
			.select({
				id: osmBuildings.id,
				osmId: osmBuildings.osmId,
				bboxMinLat: osmBuildings.bboxMinLat,
				bboxMinLng: osmBuildings.bboxMinLng,
				bboxMaxLat: osmBuildings.bboxMaxLat,
				bboxMaxLng: osmBuildings.bboxMaxLng,
				centroidLat: osmBuildings.centroidLat,
				centroidLng: osmBuildings.centroidLng,
				polygon: osmBuildings.polygon,
				address: osmBuildings.address,
			})
			.from(osmBuildings)
			.where(gt(osmBuildings.id, cursor))
			.orderBy(osmBuildings.id)
			.limit(PAGE);
		if (rows.length === 0) break;

		for (const r of rows) {
			const points = JSON.parse(r.polygon) as Array<{
				lat: number;
				lng: number;
			}>;
			const offset = used;
			for (let i = 0; i < points.length; i++) {
				rings[used++] = points[i].lat;
				rings[used++] = points[i].lng;
			}
			// RBush wants minX/minY/maxX/maxY (x = lng, y = lat); the same
			// numbers are the footprint bbox.
			tree.insert({
				id: r.id,
				osmId: r.osmId,
				centroidLat: r.centroidLat,
				centroidLng: r.centroidLng,
				ringOffset: offset,
				ringPoints: points.length,
				address: r.address,
				minX: r.bboxMinLng,
				minY: r.bboxMinLat,
				maxX: r.bboxMaxLng,
				maxY: r.bboxMaxLat,
			});
			count++;
		}
		cursor = rows[rows.length - 1].id;
	}
	cached = tree;
	console.log(
		`osm index loaded: ${count} buildings, ${used / 2} ring points (heap ${heapMb()} MB)`,
	);
	return tree;
}

/** Even-odd point-in-polygon over one ring slice of the shared `rings` array. */
function pointInRing(b: IndexedBuilding, lat: number, lng: number): boolean {
	const n = b.ringPoints;
	const base = b.ringOffset;
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = rings[base + i * 2 + 1];
		const yi = rings[base + i * 2];
		const xj = rings[base + j * 2 + 1];
		const yj = rings[base + j * 2];
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

/** Find the building containing the point; fall back to nearest centroid. */
export function matchPointLocal(
	tree: RBush<IndexedBuilding>,
	lat: number,
	lng: number,
	radiusM = 40,
): IndexedBuilding | null {
	// Query a small square around the point (radiusM ~ 0.0005 deg ≈ 55 m).
	const d = 0.0006;
	const candidates = tree.search({
		minX: lng - d,
		minY: lat - d,
		maxX: lng + d,
		maxY: lat + d,
	});

	// 1. True containment.
	for (const b of candidates) {
		if (pointInRing(b, lat, lng)) return b;
	}
	// 2. Nearest centroid within the radius.
	let best: IndexedBuilding | null = null;
	let bestDist = radiusM;
	for (const b of candidates) {
		const dist = haversineMeters(lat, lng, b.centroidLat, b.centroidLng);
		if (dist < bestDist) {
			bestDist = dist;
			best = b;
		}
	}
	return best;
}

function normStreet(s: string | null): string {
	return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Street-aware matching for RCN transactions. RCN georeferenced points can
 * sit on the plot centroid tens of meters from the building footprint
 * (new developments), so beyond the exact 40 m fallback we accept a
 * building whose addr:street matches the transaction street within
 * `streetRadiusM` (default 150 m). Only used for transactions, whose
 * addresses come from the authoritative notarial records.
 */
export function matchPointStreetAware(
	tree: RBush<IndexedBuilding>,
	lat: number,
	lng: number,
	street: string | null,
	streetRadiusM = 150,
): IndexedBuilding | null {
	// 1-2. Exact containment / 40 m nearest, as before.
	const exact = matchPointLocal(tree, lat, lng, 40);
	if (exact) return exact;

	const d = 0.002; // ~220 m search box
	const candidates = tree.search({
		minX: lng - d,
		minY: lat - d,
		maxX: lng + d,
		maxY: lat + d,
	});

	const streetNorm = normStreet(street);
	let bestStreet: IndexedBuilding | null = null;
	let bestStreetDist = streetRadiusM;
	let bestAny: IndexedBuilding | null = null;
	let bestAnyDist = streetRadiusM;

	for (const b of candidates) {
		const dist = haversineMeters(lat, lng, b.centroidLat, b.centroidLng);
		if (dist >= bestStreetDist && dist >= bestAnyDist) continue;
		const addr = normStreet(b.address);
		if (streetNorm && addr.startsWith(streetNorm) && dist < bestStreetDist) {
			bestStreetDist = dist;
			bestStreet = b;
		}
		if (dist < bestAnyDist) {
			bestAnyDist = dist;
			bestAny = b;
		}
	}
	return bestStreet ?? bestAny;
}

/**
 * True when `osm_buildings` is populated *from the current region set*.
 * The row count alone is not enough: an index built for małopolskie only
 * would happily report ready and leave every śląskie transaction
 * unanchored, so a missing/stale build marker means "rebuild".
 */
/** `osm_buildings.tags` + `polygon`, fetched on demand.
 *
 * The in-memory index carries neither: both are only needed when a footprint
 * is first inserted into the `buildings` table (cached by osm id downstream),
 * and holding them per building is what pushed the two-voivodeship index past
 * the default heap. `polygon` comes back as the stored JSON verbatim, so
 * `buildings.geometry` is byte-identical to the OSM index row.
 */
export async function osmBuildingDetails(id: number): Promise<{
	tags: string | null;
	polygon: string;
} | null> {
	const [row] = await db
		.select({ tags: osmBuildings.tags, polygon: osmBuildings.polygon })
		.from(osmBuildings)
		.where(eq(osmBuildings.id, id))
		.limit(1);
	return row ?? null;
}

export async function osmIndexReady(): Promise<boolean> {
	const rows = await db
		.select({ id: osmBuildings.id })
		.from(osmBuildings)
		.limit(1);
	if (rows.length === 0) return false;

	const state = await readBuildState();
	if (!state) {
		console.log(
			`[osm] no ${BUILD_STATE_PATH} marker; rebuilding the index for ${OSM_REGIONS.join(" + ")}`,
		);
		return false;
	}
	const covered = new Set(state.regions ?? []);
	const missing = OSM_REGIONS.filter((region) => !covered.has(region));
	if (missing.length > 0) {
		console.log(
			`[osm] index was built without ${missing.join(", ")}; rebuilding for ${OSM_REGIONS.join(" + ")}`,
		);
		return false;
	}
	return true;
}
