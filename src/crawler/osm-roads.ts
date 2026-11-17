/**
 * OSM road index for parcel access and frontage.
 *
 * The app already streams the two Geofabrik voivodeship extracts for
 * building footprints. This module makes a second pass over the same cached
 * files and keeps every public road centre line in `osm_roads`, so parcel
 * enrichment never needs a per-parcel Overpass call.
 *
 * Run once, and again when the extracts are refreshed:
 *   bun run build:osm-roads
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { osmRoads } from "#/db/schema";
import { forEachPbfItem } from "./osm/pbf.ts";
import { OSM_REGIONS, type OsmRegion } from "./osm-index.ts";

const DATA_DIR = "data/osm";
const BUILD_STATE_PATH = `${DATA_DIR}/roads-build-state.json`;
const GEOFABRIK_BASE = "https://download.geofabrik.de/europe/poland";

/**
 * Highway values that count as public or drivable access. Footways, paths
 * and cycleways are excluded on purpose: they do not create a building
 * frontage or vehicle access.
 */
const ROAD_CLASSES = new Set([
	"motorway",
	"motorway_link",
	"trunk",
	"trunk_link",
	"primary",
	"primary_link",
	"secondary",
	"secondary_link",
	"tertiary",
	"tertiary_link",
	"unclassified",
	"residential",
	"living_street",
	"service",
	"track",
	"road",
]);

interface RoadWay {
	refs: number[];
	tags: Record<string, string>;
}

interface Road {
	osmId: number;
	roadClass: string;
	surface: string | null;
	name: string | null;
	points: Array<{ lat: number; lng: number }>;
}

const PBF_SOURCES: Array<{ region: OsmRegion; url: string; path: string }> =
	OSM_REGIONS.map((region) => ({
		region,
		url: `${GEOFABRIK_BASE}/${region}-latest.osm.pbf`,
		path: `${DATA_DIR}/${region}.osm.pbf`,
	}));

async function downloadIfMissing(): Promise<void> {
	await mkdir(DATA_DIR, { recursive: true });
	for (const source of PBF_SOURCES) {
		try {
			await stat(source.path);
			continue;
		} catch {
			// download below
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

/**
 * Stream one extract twice: collect highway ways, then resolve their node
 * coordinates. The extract is ~200 MB and holds millions of nodes, so the
 * node table is a single Map that is dropped after the region is written.
 */
async function extractRoadsFromPbf(
	pbfPath: string,
	onBatch: (batch: Road[]) => Promise<void>,
): Promise<number> {
	const ways = new Map<number, RoadWay>();

	await forEachPbfItem(pbfPath, (item) => {
		if (item.type !== "way") return;
		const tags = (item.tags ?? {}) as Record<string, string>;
		const roadClass = tags.highway;
		if (!roadClass || !ROAD_CLASSES.has(roadClass)) return;
		const refs = (item.refs ?? []) as number[];
		if (refs.length < 2) return;
		ways.set(item.id as number, { refs, tags });
	});

	console.log(`road ways in ${pbfPath}: ${ways.size}`);

	const needed = new Set<number>();
	for (const way of ways.values()) {
		for (const ref of way.refs) needed.add(ref);
	}

	const coords = new Map<number, { lat: number; lng: number }>();
	await forEachPbfItem(pbfPath, (item) => {
		if (item.type !== "node") return;
		const id = item.id as number;
		if (!needed.has(id)) return;
		coords.set(id, { lat: item.lat as number, lng: item.lon as number });
	});

	let batch: Road[] = [];
	let written = 0;
	const flush = async () => {
		if (batch.length === 0) return;
		await onBatch(batch);
		written += batch.length;
		batch = [];
	};

	for (const [osmId, way] of ways) {
		const points: Array<{ lat: number; lng: number }> = [];
		for (const ref of way.refs) {
			const point = coords.get(ref);
			if (point) points.push(point);
		}
		if (points.length < 2) continue;
		batch.push({
			osmId,
			roadClass: way.tags.highway,
			surface: way.tags.surface ?? null,
			name: way.tags.name ?? null,
			points,
		});
		if (batch.length >= 2000) await flush();
	}
	await flush();
	return written;
}

function bboxOf(points: Array<{ lat: number; lng: number }>): {
	minLat: number;
	minLng: number;
	maxLat: number;
	maxLng: number;
} {
	let minLat = 90;
	let minLng = 180;
	let maxLat = -90;
	let maxLng = -180;
	for (const p of points) {
		if (p.lat < minLat) minLat = p.lat;
		if (p.lat > maxLat) maxLat = p.lat;
		if (p.lng < minLng) minLng = p.lng;
		if (p.lng > maxLng) maxLng = p.lng;
	}
	return { minLat, minLng, maxLat, maxLng };
}

/** Build `osm_roads` from the cached extracts. Full rebuild, idempotent. */
export async function buildOsmRoads(): Promise<number> {
	await downloadIfMissing();
	await db.delete(osmRoads);

	let total = 0;
	for (const source of PBF_SOURCES) {
		const written = await extractRoadsFromPbf(source.path, async (batch) => {
			await db
				.insert(osmRoads)
				.values(
					batch.map((road) => {
						const bbox = bboxOf(road.points);
						return {
							osmId: road.osmId,
							roadClass: road.roadClass,
							surface: road.surface,
							name: road.name,
							bboxMinLat: bbox.minLat,
							bboxMinLng: bbox.minLng,
							bboxMaxLat: bbox.maxLat,
							bboxMaxLng: bbox.maxLng,
							points: JSON.stringify(road.points),
						};
					}),
				)
				.onConflictDoNothing();
		});
		console.log(`  ${source.region}: ${written} roads inserted`);
		total += written;
	}

	await mkdir(DATA_DIR, { recursive: true });
	await writeFile(
		BUILD_STATE_PATH,
		JSON.stringify({
			regions: [...OSM_REGIONS],
			builtAt: new Date().toISOString(),
		}),
	);
	console.log(`osm_roads: ${total} rows inserted`);
	return total;
}

export async function osmRoadsReady(): Promise<boolean> {
	const [row] = await db.select({ n: sql<number>`count(*)` }).from(osmRoads);
	if (Number(row?.n ?? 0) === 0) return false;
	try {
		const state = JSON.parse(await readFile(BUILD_STATE_PATH, "utf8")) as {
			regions?: string[];
		};
		return OSM_REGIONS.every((region) => state.regions?.includes(region));
	} catch {
		return false;
	}
}

async function main(): Promise<void> {
	await buildOsmRoads();
}

if (
	process.argv[1]?.replace(/\\/g, "/").endsWith("/src/crawler/osm-roads.ts")
) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
