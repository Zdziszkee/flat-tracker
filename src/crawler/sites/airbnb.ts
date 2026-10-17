import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { REGIONS, type Region, regionById } from "../regions.ts";
import type { CheerioAdapter, Listing } from "../types.ts";

/**
 * Airbnb short-term rental search for every covered voivodeship
 * (Małopolska + Śląsk): adaptive quadtree partitioning.
 *
 * A single Airbnb search session exposes only ~15 cursor pages (~270
 * listings) regardless of the true count ("1000+" shown in the UI), and
 * Kraków (or the Katowice conurbation) alone holds thousands of active
 * listings. To reach the real supply each region's bounding box (from the
 * region config) is tiled on a 6x6 grid and each tile's cursor chain is
 * walked independently. Whenever a tile saturates the session cap (15 cursors
 * and a still-full final page) it is split into 4 quadrant searches which are
 * crawled too, recursively down to ~100 m boxes. The partition is therefore
 * supply-proportional: dense markets (Kraków, Tatry, Katowice) subdivide
 * deeply while empty areas stay one tile.
 *
 * Reach leaf sets are persisted per region (data/crawler/airbnb-quadtree.json
 * for Małopolska, ...-<region>.json for the rest) so subsequent crawls start
 * directly from the refined tiles instead of re-exploring top-down. Duplicate
 * listings across overlapping tiles collapse in the DB upsert on
 * `(source, externalId)`.
 *
 * Exact street addresses are hidden by Airbnb until booking, so listings are
 * anchored by coordinates and district-level analytics only.
 */

const GRID_COLS = 6;
const GRID_ROWS = 6;
/** Airbnb serves at most 15 cursor pages (~270 listings) per search. */
const CURSOR_CAP = 15;
/** Cards per page; a full final page at the cap means likely truncation. */
const PAGE_SIZE = 18;
/** Safety bound against infinite splitting (~100 m boxes at depth 8). */
const MAX_DEPTH = 8;

const CACHE_DIR = "data/crawler";

/**
 * Per-region quadtree cache. Małopolska keeps the original file name so the
 * frontier refined by every past run survives this refactor; later regions
 * get their own file so the frontiers never mix (tile names repeat across
 * regions by design).
 */
function cachePathFor(region: Region): string {
	return region.id === "malopolskie"
		? `${CACHE_DIR}/airbnb-quadtree.json`
		: `${CACHE_DIR}/airbnb-quadtree-${region.id}.json`;
}

/** One search shard: a bounding box over part of the rental market. */
interface Tile {
	name: string;
	minLat: number;
	minLng: number;
	maxLat: number;
	maxLng: number;
	depth: number;
	/** Last completed cursor-chain walk; spreads leaf revisits across runs. */
	drainedAt?: string;
	/** Listings already known from this tile (DB-aware crawl bookkeeping). */
	knownListings?: number;
}

interface QuadtreeCache {
	savedAt: string;
	tiles: Tile[];
}

function tileUrl(region: Region, t: Tile, cursor?: string): string {
	const params = new URLSearchParams({
		adults: "2",
		"refinement_paths[]": "/homes",
		search_mode: "regular_search",
		search_by_map: "true",
		ne_lat: t.maxLat.toFixed(5),
		ne_lng: t.maxLng.toFixed(5),
		sw_lat: t.minLat.toFixed(5),
		sw_lng: t.minLng.toFixed(5),
		// Zoom hints Airbnb's viewport clustering; deeper tiles zoom in.
		zoom: String(Math.min(10 + t.depth, 16)),
		// Our bookkeeping: recursion depth + owning region, echoed back on
		// every page so a crawled tile resolves to its own frontier.
		d: String(t.depth),
		r: region.id,
	});
	if (cursor) params.set("cursor", cursor);
	return `https://www.airbnb.pl/s/${encodeURIComponent(t.name)}/homes?${params.toString()}`;
}

function baseGridTiles(region: Region): Tile[] {
	const { bbox } = region;
	const tiles: Tile[] = [];
	const dLat = (bbox.maxLat - bbox.minLat) / GRID_ROWS;
	const dLng = (bbox.maxLng - bbox.minLng) / GRID_COLS;
	for (let r = 0; r < GRID_ROWS; r++) {
		for (let c = 0; c < GRID_COLS; c++) {
			tiles.push({
				name: `t${r}-${c}`,
				minLat: bbox.minLat + r * dLat,
				maxLat: bbox.minLat + (r + 1) * dLat,
				minLng: bbox.minLng + c * dLng,
				maxLng: bbox.minLng + (c + 1) * dLng,
				depth: 0,
			});
		}
	}
	return tiles;
}

function loadCachedTiles(region: Region): Tile[] | null {
	try {
		const raw = JSON.parse(
			readFileSync(cachePathFor(region), "utf8"),
		) as QuadtreeCache;
		if (!Array.isArray(raw.tiles) || raw.tiles.length === 0) return null;
		return raw.tiles.map((t) => ({ ...t }));
	} catch {
		return null;
	}
}

function persistFrontier(region: Region, tiles: Tile[]): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const cache: QuadtreeCache = {
			savedAt: new Date().toISOString(),
			tiles: [...tiles].sort(
				(a, b) => a.depth - b.depth || a.name.localeCompare(b.name),
			),
		};
		writeFileSync(cachePathFor(region), JSON.stringify(cache));
	} catch {
		// Best-effort: a failed cache write only costs re-exploration next run.
	}
}

/**
 * Crawl frontier per region: cached leaves from previous runs when available,
 * else the region's base grid. Never-drained tiles first, then stale ones,
 * shallow-first.
 */
const frontiers = new Map<string, Tile[]>();
for (const region of REGIONS) {
	const tiles = loadCachedTiles(region) ?? baseGridTiles(region);
	tiles.sort((a, b) => {
		const ta = a.drainedAt ? Date.parse(a.drainedAt) : 0;
		const tb = b.drainedAt ? Date.parse(b.drainedAt) : 0;
		return ta - tb || a.depth - b.depth || a.name.localeCompare(b.name);
	});
	frontiers.set(region.id, tiles);
}

function tilesFor(region: Region): Tile[] {
	const tiles = frontiers.get(region.id);
	if (!tiles) throw new Error(`no airbnb frontier for region ${region.id}`);
	return tiles;
}

/** The region a crawled tile URL belongs to (`r` param, Małopolska default). */
function regionOfUrl(url: string): Region {
	const id = new URL(url).searchParams.get("r");
	return id ? regionById(id) : regionById(REGIONS[0].id);
}

/**
 * Start URLs, round-robin across regions so one run's request budget (400 by
 * default) is shared instead of spent entirely on the first, far larger
 * region's backlog — otherwise the Śląsk frontier would never be reached.
 * Within a region the frontier is already staleness-sorted, and the rotation
 * simply walks both lists in lockstep (the shorter one runs out first).
 */
function interleavedStartUrls(): string[] {
	const queues = REGIONS.map((region) => ({ region, tiles: tilesFor(region) }));
	const urls: string[] = [];
	const longest = Math.max(...queues.map((q) => q.tiles.length));
	for (let i = 0; i < longest; i++) {
		for (const { region, tiles } of queues) {
			const tile = tiles[i];
			if (tile) urls.push(tileUrl(region, tile));
		}
	}
	return urls;
}

function markDrained(region: Region, name: string): void {
	const tiles = tilesFor(region);
	const tile = tiles.find((t) => t.name === name);
	if (!tile) return;
	tile.drainedAt = new Date().toISOString();
	persistFrontier(region, tiles);
}

/**
 * DB-aware crawl: when enabled (default), each drained tile records how
 * many of its listings are already stored, and tiles whose last walk
 * yielded nothing new are demoted so the next run spends its budget on
 * tiles that still grow the DB.
 */
const SKIP_KNOWN =
	(process.env.AIRBNB_SKIP_KNOWN ?? "1") !== "0" &&
	typeof process !== "undefined";

async function countListingsInBox(
	minLat: number,
	minLng: number,
	maxLat: number,
	maxLng: number,
): Promise<number | null> {
	if (!SKIP_KNOWN) return null;
	try {
		const { db } = await import("../../db/index.ts");
		const { listings } = await import("../../db/schema.ts");
		const rows = await db
			.select({
				c: sql<number>`count(*)`,
			})
			.from(listings)
			.where(
				sql`${listings.source} = 'airbnb' AND ${listings.lat} between ${minLat} and ${maxLat} AND ${listings.lng} between ${minLng} and ${maxLng}`,
			);
		return rows[0]?.c ?? 0;
	} catch {
		return null;
	}
}

/** Delta mode: skip re-walking tiles whose supply hasn't changed (429s). */
const DELTA_ENABLED =
	(process.env.AIRBNB_DELTA ?? "1") !== "0" && typeof process !== "undefined";

/**
 * Hours after which a tile earns a full cursor-chain sweep again even if
 * its first pages look unchanged: rankings rotate below the fold and new
 * supply appears past the visible window. Default: full walk once a day.
 */
const FULL_SWEEP_HOURS = Number(process.env.AIRBNB_FULL_SWEEP_HOURS ?? 24);

/**
 * externalIds already stored inside a bbox — the delta fingerprint for a
 * tile's page-1 change probe.
 */
async function knownIdsInBox(
	minLat: number,
	minLng: number,
	maxLat: number,
	maxLng: number,
): Promise<Set<string> | null> {
	if (!DELTA_ENABLED) return null;
	try {
		const { db } = await import("../../db/index.ts");
		const { listings } = await import("../../db/schema.ts");
		const rows = await db
			.select({ externalId: listings.externalId })
			.from(listings)
			.where(
				sql`${listings.source} = 'airbnb' AND ${listings.lat} between ${minLat} and ${maxLat} AND ${listings.lng} between ${minLng} and ${maxLng}`,
			);
		return new Set(rows.map((r) => r.externalId));
	} catch {
		return null;
	}
}

function tileNeedsFullSweep(t: Tile | undefined): boolean {
	if (!t?.drainedAt) return true; // never drained -> must walk fully
	const ageMs = Date.now() - Date.parse(t.drainedAt);
	return !Number.isFinite(ageMs) || ageMs > FULL_SWEEP_HOURS * 3600_000;
}

function replaceTile(region: Region, tile: Tile, kids: Tile[]): void {
	const tiles = tilesFor(region);
	const idx = tiles.findIndex((t) => t.name === tile.name);
	if (idx >= 0) tiles.splice(idx, 1, ...kids);
	else tiles.push(...kids);
	persistFrontier(region, tiles);
}

function childrenOf(parent: {
	name: string;
	minLat: number;
	minLng: number;
	maxLat: number;
	maxLng: number;
	depth: number;
}): Tile[] {
	const midLat = (parent.minLat + parent.maxLat) / 2;
	const midLng = (parent.minLng + parent.maxLng) / 2;
	const n = parent.name;
	const d = parent.depth + 1;
	return [
		{
			name: `${n}1`,
			minLat: midLat,
			maxLat: parent.maxLat,
			minLng: midLng,
			maxLng: parent.maxLng,
			depth: d,
		},
		{
			name: `${n}2`,
			minLat: midLat,
			maxLat: parent.maxLat,
			minLng: parent.minLng,
			maxLng: midLng,
			depth: d,
		},
		{
			name: `${n}3`,
			minLat: parent.minLat,
			maxLat: midLat,
			minLng: midLng,
			maxLng: parent.maxLng,
			depth: d,
		},
		{
			name: `${n}4`,
			minLat: parent.minLat,
			maxLat: midLat,
			minLng: parent.minLng,
			maxLng: midLng,
			depth: d,
		},
	];
}

interface Coordinate {
	latitude?: number;
	longitude?: number;
}

interface StaySearchResult {
	__typename?: string;
	title?: string;
	subtitle?: string;
	avgRatingLocalized?: string;
	structuredDisplayPrice?: {
		primaryLine?: { accessibilityLabel?: string };
		explanationData?: {
			priceDetails?: Array<{
				items?: Array<{ description?: string; priceString?: string }>;
			}>;
		};
	};
	demandStayListing?: {
		id?: string;
		location?: { coordinate?: Coordinate };
	};
}

function findSearchResults(node: unknown): StaySearchResult[] | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const v of node) {
			const r = findSearchResults(v);
			if (r) return r;
		}
		return null;
	}
	const obj = node as Record<string, unknown>;
	if (obj.searchResults && Array.isArray(obj.searchResults)) {
		return obj.searchResults as StaySearchResult[];
	}
	for (const v of Object.values(obj)) {
		const r = findSearchResults(v);
		if (r) return r;
	}
	return null;
}

function decodeListingId(base64: string | undefined): string | null {
	if (!base64) return null;
	try {
		const decoded = Buffer.from(base64, "base64").toString("utf8");
		const idx = decoded.lastIndexOf(":");
		return idx >= 0 ? decoded.slice(idx + 1) : decoded;
	} catch {
		return null;
	}
}

/** Parse "5 nocy x 929,00 zł" -> 929. */
function parseNightlyRate(desc: string | undefined): number | null {
	if (!desc) return null;
	const m = desc.match(/x\s*([\d\s.,]+)/i);
	if (!m) return null;
	const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse "4,98 (49)" -> { rating: 4.98, reviews: 49 }. */
function parseRating(localized: string | undefined): {
	rating: number | null;
	reviews: number | null;
} {
	if (!localized) return { rating: null, reviews: null };
	const m = localized.match(/([\d,]+)\s*\((\d+)\)/);
	if (!m) return { rating: null, reviews: null };
	const rating = Number(m[1].replace(",", "."));
	const reviews = Number(m[2]);
	return {
		rating: Number.isFinite(rating) ? rating : null,
		reviews: Number.isFinite(reviews) ? reviews : null,
	};
}

function resultToListing(r: StaySearchResult): Listing {
	const listingId = decodeListingId(r.demandStayListing?.id);
	const rawId = r.demandStayListing?.id ?? "";
	const { rating, reviews } = parseRating(r.avgRatingLocalized);
	const priceDetail = r.structuredDisplayPrice?.explanationData?.priceDetails;
	const nightlyLine = priceDetail
		?.flatMap((p) => p.items ?? [])
		.find((i) => i.description && /nocy\s*x/i.test(i.description));
	const price = parseNightlyRate(nightlyLine?.description);
	const lat = r.demandStayListing?.location?.coordinate?.latitude ?? null;
	const lng = r.demandStayListing?.location?.coordinate?.longitude ?? null;

	return {
		source: "airbnb",
		externalId: listingId ?? r.demandStayListing?.id ?? "",
		url:
			listingId || rawId
				? `https://www.airbnb.pl/rooms/${listingId || rawId}`
				: "",
		title: r.subtitle ?? r.title ?? "Airbnb listing",
		price,
		pricePerM2: null,
		areaM2: null,
		rooms: null,
		floor: null,
		district: null,
		address: null,
		description: null,
		heatingType: null,
		propertyType: null,
		features: JSON.stringify({
			avgRatingLocalized: r.avgRatingLocalized ?? null,
			priceDetail: priceDetail ?? null,
		}),
		lat: lat && lng ? lat : null,
		lng: lat && lng ? lng : null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
		offerType: "short_term_rental",
		pricePeriod: "night",
		rating,
		reviewsCount: reviews,
	};
}

export const airbnbAdapter: CheerioAdapter = {
	id: "airbnb",
	name: "Airbnb - Małopolska + Śląsk short-term rentals",
	kind: "cheerio",
	// Every region's frontier is walked; tiles carry their region in the URL
	// (`r=`) so pagination and splitting stay inside it, and the two frontiers
	// are interleaved so the run budget covers both.
	startUrls: interleavedStartUrls(),
	// Per-run ceiling; the frontier persists across runs, so coverage grows
	// run over run (default keeps the hourly refresh polite).
	maxRequestsPerCrawl: Math.min(
		5000,
		Math.max(40, Number(process.env.AIRBNB_MAX_REQUESTS ?? 400)),
	),
	// Airbnb rankings are not newest-first, so a first-page-only hourly run
	// would see nothing new past the first tile (crawler.ts caps it at 1
	// request). Always walk every leaf tile.
	alwaysFullCrawl: true,

	async extractHtml(html, url, enqueue) {
		const match = html.match(
			/<script id="data-deferred-state-0"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/,
		);
		if (!match) return [];
		let data: unknown;
		try {
			data = JSON.parse(match[1]);
		} catch {
			return [];
		}

		const region = regionOfUrl(url);

		const results = findSearchResults(data) ?? [];

		// Pagination is a base64 cursor list. Page 1 (no `cursor` param)
		// continues at cursors[0]; later pages continue at their successor.
		const pageCursors = (() => {
			const walk = (n: unknown): string[] | null => {
				if (!n || typeof n !== "object") return null;
				if (Array.isArray(n)) {
					for (const v of n) {
						const r = walk(v);
						if (r) return r;
					}
					return null;
				}
				const o = n as Record<string, unknown>;
				if (Array.isArray(o.pageCursors)) return o.pageCursors as string[];
				for (const v of Object.values(o)) {
					const r = walk(v);
					if (r) return r;
				}
				return null;
			};
			return walk(data) ?? [];
		})();

		const u = new URL(url);
		const current = u.searchParams.get("cursor");

		// ---- Delta probe (page 1 of a previously drained tile) -----------
		// Airbnb rankings rotate below the fold, so before paying for the
		// full ~15-request cursor chain compare the page-1 fingerprints
		// against the DB. When every first-page listing is already stored
		// AND the tile had a full sweep recently, stop here: the chain has
		// nothing new. This is what keeps the hourly refresh at ~1 request
		// per unchanged tile instead of ~15 (the source of the 429 storms).
		if (DELTA_ENABLED && current == null) {
			const tile0: Tile = {
				name: decodeURIComponent(u.pathname.split("/")[2] ?? "?"),
				minLat: Number(u.searchParams.get("sw_lat")),
				minLng: Number(u.searchParams.get("sw_lng")),
				maxLat: Number(u.searchParams.get("ne_lat")),
				maxLng: Number(u.searchParams.get("ne_lng")),
				depth: Number(u.searchParams.get("d") ?? "0"),
			};
			const cached = tilesFor(region).find((t) => t.name === tile0.name);
			if (cached && !tileNeedsFullSweep(cached)) {
				const knownIds = await knownIdsInBox(
					tile0.minLat,
					tile0.minLng,
					tile0.maxLat,
					tile0.maxLng,
				);
				if (knownIds && results.length > 0) {
					const allKnown = results.every((r) => {
						const id = resultToListing(r).externalId;
						return id !== "" && knownIds.has(id);
					});
					if (allKnown) {
						markDrained(region, tile0.name);
						console.log(
							`airbnb: delta skip ${tile0.name} (${results.length} known, page 1 unchanged)`,
						);
						return results.map(resultToListing);
					}
					console.log(
						`airbnb: delta changed ${tile0.name} (new ids on page 1), walking chain`,
					);
				}
			}
		}

		if (pageCursors.length > 0) {
			const currentIndex = current ? pageCursors.indexOf(current) : -1;
			if (current != null && currentIndex === -1) {
				// Stale cursor (session rotated between runs): stop walking
				// instead of looping back to page 2 forever.
				console.warn(`airbnb: stale cursor in ${u.pathname}, stopping chain`);
			} else {
				const next = pageCursors[currentIndex + 1];
				if (next) {
					u.searchParams.set("cursor", next);
					await enqueue([u.toString()]);
					return results.map(resultToListing);
				}
			}
		}

		// Chain complete (or unwalkable). Saturated = hit the cursor cap with
		// a still-full final page: Airbnb truncated this search, so split the
		// tile into quadrants (each gets its own session budget).
		const tile: Tile = {
			name: decodeURIComponent(u.pathname.split("/")[2] ?? "?"),
			minLat: Number(u.searchParams.get("sw_lat")),
			minLng: Number(u.searchParams.get("sw_lng")),
			maxLat: Number(u.searchParams.get("ne_lat")),
			maxLng: Number(u.searchParams.get("ne_lng")),
			depth: Number(u.searchParams.get("d") ?? "0"),
		};
		// Was this leaf fully walked by an earlier run? Only then may we
		// trust the DB count to skip its pagination (fresh tiles must walk).
		const wasDrainedBefore =
			tilesFor(region).find((t) => t.name === tile.name)?.drainedAt != null;
		markDrained(region, tile.name);
		const known = await countListingsInBox(
			tile.minLat,
			tile.minLng,
			tile.maxLat,
			tile.maxLng,
		);
		if (known != null) tile.knownListings = known;
		persistFrontier(region, tilesFor(region));
		if (
			SKIP_KNOWN &&
			wasDrainedBefore &&
			pageCursors.length > 0 &&
			results.length >= PAGE_SIZE &&
			tile.knownListings != null &&
			tile.knownListings <= results.length
		) {
			// Fully drained before AND every listing on the first page is
			// already stored: nothing new to walk. Demote it (stale drainedAt)
			// so future runs prefer tiles that still grow the DB.
			return results.map(resultToListing);
		}
		const saturated =
			pageCursors.length >= CURSOR_CAP && results.length >= PAGE_SIZE;
		if (saturated && tile.depth < MAX_DEPTH) {
			const kids = childrenOf(tile);
			replaceTile(region, tile, kids);
			console.log(
				`airbnb: split ${tile.name} at depth ${tile.depth} -> ${kids.map((k) => k.name).join(" ")}`,
			);
			await enqueue(kids.map((k) => tileUrl(region, k)));
		}

		return results.map(resultToListing);
	},
};
