/**
 * Region-wide cadastral parcel import for małopolska from GUGiK's KIEG
 * aggregate WFS ("Zbiorcza usługa EGiB",
 * https://mapy.geoportal.gov.pl/wss/service/PZGIK/EGIB/WFS/UslugaZbiorcza).
 *
 * The service exposes one normalized feature type (ms:dzialki) for the
 * whole country: ID_DZIALKI in the same registry format as RCN parcels
 * (e.g. 126105_9.0003.55), polygon in the requested CRS, obręb/gmina
 * names. It caps pages at 1000 features and supports STARTINDEX paging;
 * there is no total count (numberMatched="unknown"), so we page until a
 * page returns fewer than the page size.
 *
 * Strategy: tile the małopolska bbox, GetFeature per tile with BBOX +
 * pagination, parse each page (~1.5 MB XML) with saxes and INSERT OR
 * IGNORE into `parcels` — RCN rows (Krakow) are imported first and win,
 * so KIEG only fills the rest of the region. Features straddling tile
 * edges are returned by neighbouring tiles; the unique parcelId
 * dedupes them.
 *
 * Resume support: completed tiles are recorded in
 * data/crawler/egib-state.json, so an interrupted run continues where
 * it stopped. Re-runs are also harmless thanks to INSERT OR IGNORE.
 *
 * Run with Node via tsx (better-sqlite3 does not work under Bun):
 *   bun run import:egib [-- --tiles=12]   # smoke-test the first N tiles
 */

import "dotenv/config";

import { eq, sql } from "drizzle-orm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { db } from "#/db/index";
import { parcels as parcelsTable } from "#/db/schema";
import { SaxesParser } from "saxes";

// ---------------------------------------------------------------------------
// Config

/** Małopolska voivodeship bounding box (lon/lat), slightly padded. */
const MALOPOLSKA = { minLng: 19.13, minLat: 49.05, maxLng: 21.3, maxLat: 50.45 };

/** Tile size in degrees (~7.2 km × 8.9 km at 50°N). */
const TILE_LNG = 0.1;
const TILE_LAT = 0.08;

const WFS_URL =
	"https://mapy.geoportal.gov.pl/wss/service/PZGIK/EGIB/WFS/UslugaZbiorcza";
const PAGE_SIZE = 1000; // server-enforced cap
const MAX_PAGES_PER_TILE = 400; // runaway guard (~400k parcels/tile)
const REQUEST_DELAY_MS = 300;
const MAX_RETRIES = 5;
const UA = "flat-tracker/1.0 (cadastral parcel index; contact: zdziszkee@gmail.com)";

const DB_PATH = process.env.DATABASE_URL?.replace(/^file:/, "") ?? "dev.db";
const STATE_PATH = "data/crawler/egib-state.json";

// ---------------------------------------------------------------------------
// CLI: --tiles=N runs only the first N pending tiles (smoke test);
// --tile=row:col runs one specific tile (repeatable)

const tilesArg = process.argv.find((a) => a.startsWith("--tiles="));
const tileLimit = tilesArg ? Number.parseInt(tilesArg.split("=")[1], 10) : null;
const tileKeys = process.argv
	.filter((a) => a.startsWith("--tile="))
	.map((a) => a.split("=")[1]);

// ---------------------------------------------------------------------------
// Tile grid

const cols = Math.ceil((MALOPOLSKA.maxLng - MALOPOLSKA.minLng) / TILE_LNG);
const rows = Math.ceil((MALOPOLSKA.maxLat - MALOPOLSKA.minLat) / TILE_LAT);

interface Tile {
	key: string;
	minLng: number;
	minLat: number;
	maxLng: number;
	maxLat: number;
}

function buildTiles(): Tile[] {
	const tiles: Tile[] = [];
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			tiles.push({
				key: `${row}:${col}`,
				minLng: MALOPOLSKA.minLng + col * TILE_LNG,
				minLat: MALOPOLSKA.minLat + row * TILE_LAT,
				maxLng: Math.min(
					MALOPOLSKA.minLng + (col + 1) * TILE_LNG,
					MALOPOLSKA.maxLng,
				),
				maxLat: Math.min(
					MALOPOLSKA.minLat + (row + 1) * TILE_LAT,
					MALOPOLSKA.maxLat,
				),
			});
		}
	}
	return tiles;
}

// ---------------------------------------------------------------------------
// Resume state

interface EgibState {
	completedTiles: string[];
}

function loadState(): EgibState {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8")) as EgibState;
	} catch {
		return { completedTiles: [] };
	}
}

const state = loadState();
const completed = new Set(state.completedTiles);

function saveState(): void {
	state.completedTiles = [...completed];
	mkdirSync("data/crawler", { recursive: true });
	writeFileSync(STATE_PATH, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// DB (drizzle over better-sqlite3; runs under Node via tsx, never Bun)

interface ParcelInsert {
	parcelId: string;
	ring: Array<{ lat: number; lng: number }>;
	obreb: string | null;
	gmina: string | null;
}

function insertBatch(batch: ParcelInsert[]): number {
	const rows = batch.map((p) => {
		let minLat = 90;
		let minLng = 180;
		let maxLat = -90;
		let maxLng = -180;
		let cLat = 0;
		let cLng = 0;
		for (const pt of p.ring) {
			if (pt.lat < minLat) minLat = pt.lat;
			if (pt.lat > maxLat) maxLat = pt.lat;
			if (pt.lng < minLng) minLng = pt.lng;
			if (pt.lng > maxLng) maxLng = pt.lng;
			cLat += pt.lat;
			cLng += pt.lng;
		}
		const n = p.ring.length;
		return {
			parcelId: p.parcelId,
			bboxMinLat: minLat,
			bboxMinLng: minLng,
			bboxMaxLat: maxLat,
			bboxMaxLng: maxLng,
			centroidLat: cLat / n,
			centroidLng: cLng / n,
			polygon: JSON.stringify(p.ring),
			source: "egib" as const,
			obreb: p.obreb,
			gmina: p.gmina,
		};
	});
	const res = db
		.insert(parcelsTable)
		.values(rows)
		.onConflictDoNothing({ target: parcelsTable.parcelId })
		.run();
	return res.changes;
}

// ---------------------------------------------------------------------------
// WFS page fetch with retry + backoff

async function fetchPage(tile: Tile, startIndex: number): Promise<string> {
	const bbox = `${tile.minLat},${tile.minLng},${tile.maxLat},${tile.maxLng},urn:ogc:def:crs:EPSG::4326`;
	// SORTBY is essential: without a stable order the server's paging is
	// nondeterministic (observed 965 vs 979 features for identical
	// requests), which silently skips parcels across pages.
	const url =
		`${WFS_URL}?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0&TYPENAMES=ms:dzialki` +
		`&SRSNAME=urn:ogc:def:crs:EPSG::4326&BBOX=${encodeURIComponent(bbox)}` +
		`&COUNT=${PAGE_SIZE}&STARTINDEX=${startIndex}&SORTBY=ms:ID_DZIALKI`;

	for (let attempt = 0; ; attempt++) {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": UA },
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) {
				// 429/5xx are transient; anything else is a hard failure for
				// this page — throw a fatal marker that skips retries.
				const fatal = res.status !== 429 && res.status < 500;
				throw new Error(`HTTP ${res.status}${fatal ? " (fatal)" : ""}`);
			}
			return await res.text();
		} catch (err) {
			const fatal = err instanceof Error && err.message.includes("(fatal)");
			if (fatal || attempt >= MAX_RETRIES) throw err;
			const backoff = Math.min(1000 * 2 ** attempt, 30_000);
			console.warn(
				`  retry ${attempt + 1}/${MAX_RETRIES} for ${tile.key}@${startIndex} after ${backoff} ms (${err})`,
			);
			await new Promise((r) => setTimeout(r, backoff));
		}
	}
}

// ---------------------------------------------------------------------------
// Streaming GML parse of one page (saxes) -> parcel inserts

interface PendingParcel {
	parcelId: string | null;
	obreb: string | null;
	gmina: string | null;
	posList: string;
}

function parsePage(xml: string): ParcelInsert[] {
	// Full-document mode: the WFS response starts with an XML declaration,
	// which fragment mode rejects.
	const parser = new SaxesParser({ xmlns: false });
	const out: ParcelInsert[] = [];
	let member: PendingParcel | null = null;
	let capture: "idDzialki" | "obreb" | "gmina" | null = null;
	let inPosList = false;

	parser.on("opentag", (node) => {
		const name = node.name;
		if (name === "ms:dzialki") {
			member = { parcelId: null, obreb: null, gmina: null, posList: "" };
		} else if (member) {
			if (name === "gml:posList") inPosList = true;
			else if (name === "ms:ID_DZIALKI") capture = "idDzialki";
			else if (name === "ms:NAZWA_OBREBU") capture = "obreb";
			else if (name === "ms:NAZWA_GMINY") capture = "gmina";
		}
	});
	parser.on("text", (t) => {
		if (!member) return;
		if (inPosList) member.posList += t;
		else if (capture === "idDzialki") member.parcelId = (member.parcelId ?? "") + t;
		else if (capture === "obreb") member.obreb = (member.obreb ?? "") + t;
		else if (capture === "gmina") member.gmina = (member.gmina ?? "") + t;
	});
	parser.on("closetag", (node) => {
		const name = node.name;
		if (name === "gml:posList") inPosList = false;
		else if (
			name === "ms:ID_DZIALKI" ||
			name === "ms:NAZWA_OBREBU" ||
			name === "ms:NAZWA_GMINY"
		) {
			capture = null;
		} else if (name === "ms:dzialki" && member) {
			const m = member;
			member = null;
			if (m.parcelId && m.posList) {
				const ring = parsePosList(m.posList);
				if (ring && ring.length >= 3) {
					out.push({
						parcelId: m.parcelId,
						ring,
						obreb: m.obreb || null,
						gmina: m.gmina || null,
					});
				}
			}
		}
	});
	parser.write(xml).close();
	return out;
}

/** Parse "lat lon lat lon …" (URN EPSG::4326 axis order) into {lat,lng} ring. */
function parsePosList(
	text: string,
): Array<{ lat: number; lng: number }> | null {
	const nums = text.trim().split(/\s+/).map(Number);
	if (nums.length < 6 || nums.length % 2 !== 0) return null;
	const ring: Array<{ lat: number; lng: number }> = [];
	for (let i = 0; i < nums.length; i += 2) {
		const lat = nums[i];
		const lng = nums[i + 1];
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		// małopolska sanity bounds
		if (lat < 48.5 || lat > 51 || lng < 18.5 || lng > 22) return null;
		const prev = ring[ring.length - 1];
		// drop consecutive duplicates
		if (prev && prev.lat === lat && prev.lng === lng) continue;
		ring.push({ lat, lng });
	}
	if (ring.length > 1) {
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (first.lat === last.lat && first.lng === last.lng) ring.pop();
	}
	return ring;
}

// ---------------------------------------------------------------------------
// Tile import with adaptive subdivision.
//
// Two server-side limits shape this:
// 1. STARTINDEX caps at 10000 (page 11+ returns HTTP 400), so a bbox
//    holding >10k parcels cannot be paged through.
// 2. SORTBY=ms:ID_DZIALKI — REQUIRED for stable pagination (unordered
//    paging silently skips features) — itself returns HTTP 400 on large
//    bboxes (server-side sort cost). On quadrant-sized bboxes (~0.05°)
//    it works reliably.
// Therefore every base tile is first split into quadrants before
// fetching; further subdivision kicks in if a quadrant still trips
// either limit. Inserted counts accumulate on module-level totals.

const MIN_SPAN = 0.005; // ~500 m; densest urbam parcels stay under 10k

async function importTile(tile: Tile, depth = 0): Promise<void> {
	// Pre-split base tiles into quadrants: SORTBY (needed for stable
	// paging) fails with HTTP 400 on full-tile bboxes.
	if (depth === 0) {
		const quads = splitTile(tile);
		for (const q of quads) {
			await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
			await importTile(q, 1);
		}
		return;
	}
	try {
		await pageThrough(tile);
		return;
	} catch (err) {
		// Retry-subdivide only on WFS 400s (STARTINDEX cap or SORTBY
		// cost); anything else (network, 5xx exhaustion) propagates.
		if (!(err instanceof Error) || !err.message.includes("400") || depth > 6) {
			throw err;
		}
		const spanLng = tile.maxLng - tile.minLng;
		const spanLat = tile.maxLat - tile.minLat;
		if (spanLng / 2 < MIN_SPAN && spanLat / 2 < MIN_SPAN) throw err;
		console.warn(
			`  ${tile.key}: WFS 400 (cap/sort), subdividing (depth ${depth})`,
		);
		for (const q of splitTile(tile)) {
			await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
			await importTile(q, depth + 1);
		}
	}
}

function splitTile(tile: Tile): Tile[] {
	const midLng = (tile.minLng + tile.maxLng) / 2;
	const midLat = (tile.minLat + tile.maxLat) / 2;
	return [
		{ key: `${tile.key}a`, minLng: tile.minLng, minLat: tile.minLat, maxLng: midLng, maxLat: midLat },
		{ key: `${tile.key}b`, minLng: midLng, minLat: tile.minLat, maxLng: tile.maxLng, maxLat: midLat },
		{ key: `${tile.key}c`, minLng: tile.minLng, minLat: midLat, maxLng: midLng, maxLat: tile.maxLat },
		{ key: `${tile.key}d`, minLng: midLng, minLat: midLat, maxLng: tile.maxLng, maxLat: tile.maxLat },
	];
}

async function pageThrough(tile: Tile): Promise<void> {
	let startIndex = 0;
	while (startIndex < PAGE_SIZE * MAX_PAGES_PER_TILE) {
		const xml = await fetchPage(tile, startIndex);
		const batch = parsePage(xml);
		if (batch.length > 0) insertBatch(batch);
		// The server's real page cap varies (947-999 observed) and can be
		// below COUNT, so "short page" does NOT mean "last page". Continue
		// until an EMPTY page or the hard STARTINDEX cap of 10000.
		if (batch.length === 0) break;
		startIndex += batch.length;
	}
}

async function main() {
	const allTiles = buildTiles();
	let pending = allTiles.filter((t) => !completed.has(t.key));
	if (tileKeys.length > 0) pending = pending.filter((t) => tileKeys.includes(t.key));
	const runTiles = tileLimit != null ? pending.slice(0, tileLimit) : pending;
	console.log(
		`EGIB import: ${completed.size}/${allTiles.length} tiles already done, running ${runTiles.length} (grid ${cols}x${rows}, DB ${DB_PATH})`,
	);

	const t0 = Date.now();
	let insertedTotal = 0;

	for (let i = 0; i < runTiles.length; i++) {
		const tile = runTiles[i];
		const before = await countParcels();
		try {
			await importTile(tile);
			completed.add(tile.key);
		} catch (err) {
			console.error(`Tile ${tile.key} FAILED, will retry on next run: ${err}`);
		}
		const after = await countParcels();
		insertedTotal += after - before;
		if ((i + 1) % 10 === 0 || i === runTiles.length - 1) {
			saveState();
			const mins = (Date.now() - t0) / 60_000;
			console.log(
				`[${i + 1}/${runTiles.length}] ${tile.key} | +${after - before} this tile, ${insertedTotal} this run | ${mins.toFixed(1)} min elapsed`,
			);
		}
		await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
	}

	saveState();
	console.log(
		`Done: ${insertedTotal} newly inserted. Completed tiles: ${completed.size}/${allTiles.length}.`,
	);
}

let _lastCount = -1;
async function countParcels(): Promise<number> {
	const rows = await db
		.select({ c: sql<number>`count(*)` })
		.from(parcelsTable)
		.where(eq(parcelsTable.source, "egib"));
	_lastCount = Number(rows[0]?.c ?? 0);
	return _lastCount;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
