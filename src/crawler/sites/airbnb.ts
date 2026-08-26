import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { CheerioAdapter, Listing } from "../types.ts";

/**
 * Airbnb short-term rental search for Małopolska: adaptive quadtree
 * partitioning.
 *
 * A single Airbnb search session exposes only ~15 cursor pages (~270
 * listings) regardless of the true count ("1000+" shown in the UI), and
 * Kraków alone holds thousands of active listings. To reach the real supply
 * the region is tiled on a 6x6 grid and each tile's cursor chain is walked
 * independently. Whenever a tile saturates the session cap (15 cursors and
 * a still-full final page) it is split into 4 quadrant searches which are
 * crawled too, recursively down to ~100 m boxes. The partition is therefore
 * supply-proportional: dense markets (Kraków, Tatry) subdivide deeply while
 * empty areas stay one tile.
 *
 * The reached leaf set is persisted to data/crawler/airbnb-quadtree.json so
 * subsequent crawls start directly from the refined tiles instead of
 * re-exploring top-down. Duplicate listings across overlapping tiles collapse
 * in the DB upsert on `(source, externalId)`.
 *
 * Exact street addresses are hidden by Airbnb until booking, so listings are
 * anchored by coordinates and district-level analytics only.
 */

/** Małopolska bounds (union of powiat polygons). */
const REGION = {
	minLat: 49.18,
	minLng: 19.0831,
	maxLat: 50.5205,
	maxLng: 21.4217,
};
const GRID_COLS = 6;
const GRID_ROWS = 6;
/** Airbnb serves at most 15 cursor pages (~270 listings) per search. */
const CURSOR_CAP = 15;
/** Cards per page; a full final page at the cap means likely truncation. */
const PAGE_SIZE = 18;
/** Safety bound against infinite splitting (~100 m boxes at depth 8). */
const MAX_DEPTH = 8;

const CACHE_DIR = "data/crawler";
const CACHE_PATH = `${CACHE_DIR}/airbnb-quadtree.json`;

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

function tileUrl(t: Tile, cursor?: string): string {
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
		// Our bookkeeping: recursion depth, echoed back on every page.
		d: String(t.depth),
	});
	if (cursor) params.set("cursor", cursor);
	return `https://www.airbnb.pl/s/${encodeURIComponent(t.name)}/homes?${params.toString()}`;
}

function baseGridTiles(): Tile[] {
	const tiles: Tile[] = [];
	const dLat = (REGION.maxLat - REGION.minLat) / GRID_ROWS;
	const dLng = (REGION.maxLng - REGION.minLng) / GRID_COLS;
	for (let r = 0; r < GRID_ROWS; r++) {
		for (let c = 0; c < GRID_COLS; c++) {
			tiles.push({
				name: `t${r}-${c}`,
				minLat: REGION.minLat + r * dLat,
				maxLat: REGION.minLat + (r + 1) * dLat,
				minLng: REGION.minLng + c * dLng,
				maxLng: REGION.minLng + (c + 1) * dLng,
				depth: 0,
			});
		}
	}
	return tiles;
}

function loadCachedTiles(): Tile[] | null {
	try {
		const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as QuadtreeCache;
		if (!Array.isArray(raw.tiles) || raw.tiles.length === 0) return null;
		return raw.tiles.map((t) => ({ ...t }));
	} catch {
		return null;
	}
}

function persistFrontier(tiles: Tile[]): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const cache: QuadtreeCache = {
			savedAt: new Date().toISOString(),
			tiles: [...tiles].sort(
				(a, b) => a.depth - b.depth || a.name.localeCompare(b.name),
			),
		};
		writeFileSync(CACHE_PATH, JSON.stringify(cache));
	} catch {
		// Best-effort: a failed cache write only costs re-exploration next run.
	}
}

/**
 * Crawl frontier: cached leaves from previous runs when available, else the
 * base grid. Never-drained tiles first, then stale ones, shallow-first.
 */
const frontier: Tile[] = loadCachedTiles() ?? baseGridTiles();
frontier.sort((a, b) => {
	const ta = a.drainedAt ? Date.parse(a.drainedAt) : 0;
	const tb = b.drainedAt ? Date.parse(b.drainedAt) : 0;
	return ta - tb || a.depth - b.depth || a.name.localeCompare(b.name);
});

function markDrained(name: string): void {
	const tile = frontier.find((t) => t.name === name);
	if (!tile) return;
	tile.drainedAt = new Date().toISOString();
	persistFrontier(frontier);
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

function replaceTile(tile: Tile, kids: Tile[]): void {
	const idx = frontier.findIndex((t) => t.name === tile.name);
	if (idx >= 0) frontier.splice(idx, 1, ...kids);
	else frontier.push(...kids);
	persistFrontier(frontier);
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
	name: "Airbnb - Małopolska short-term rentals",
	kind: "cheerio",
	startUrls: frontier.map((t) => tileUrl(t)),
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
			frontier.find((t) => t.name === tile.name)?.drainedAt != null;
		markDrained(tile.name);
		const known = await countListingsInBox(
			tile.minLat,
			tile.minLng,
			tile.maxLat,
			tile.maxLng,
		);
		if (known != null) tile.knownListings = known;
		persistFrontier(frontier);
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
			replaceTile(tile, kids);
			console.log(
				`airbnb: split ${tile.name} at depth ${tile.depth} -> ${kids.map((k) => k.name).join(" ")}`,
			);
			await enqueue(kids.map((k) => tileUrl(k)));
		}

		return results.map(resultToListing);
	},
};
