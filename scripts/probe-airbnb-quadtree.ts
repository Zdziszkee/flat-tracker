/**
 * Throwaway probe: validate adaptive quadtree partitioning of Airbnb search.
 * Starts from one base tile of the region grid and recursively splits any
 * tile whose cursor chain saturates (15 cursors + full last page), counting
 * unique listings reachable. Mirrors the intended adapter logic.
 *
 * Usage: bunx tsx scripts/probe-airbnb-quadtree.ts [col,row] [maxRequests]
 */
const COLS = 6;
const ROWS = 6;
const REGION = { minLat: 49.18, minLng: 19.0831, maxLat: 50.5205, maxLng: 21.4217 };
const CURSOR_CAP = 15;
const PAGE_FULL = 18;
const MAX_DEPTH = 8;

const argTile = process.argv[2]; // e.g. "1,2"
const maxRequests = Number(process.argv[3] ?? 260);

interface Tile {
	name: string;
	minLat: number;
	minLng: number;
	maxLat: number;
	maxLng: number;
	depth: number;
}

function tileUrl(t: Tile, cursor?: string): string {
	const p = new URLSearchParams({
		adults: "2",
		"refinement_paths[]": "/homes",
		search_mode: "regular_search",
		search_by_map: "true",
		ne_lat: String(t.maxLat),
		ne_lng: String(t.maxLng),
		sw_lat: String(t.minLat),
		sw_lng: String(t.minLng),
		zoom: String(Math.min(10 + t.depth, 16)),
		d: String(t.depth),
	});
	if (cursor) p.set("cursor", cursor);
	return `https://www.airbnb.pl/s/${encodeURIComponent(t.name)}/homes?${p.toString()}`;
}

function baseTiles(): Tile[] {
	const tiles: Tile[] = [];
	const dLat = (REGION.maxLat - REGION.minLat) / ROWS;
	const dLng = (REGION.maxLng - REGION.minLng) / COLS;
	for (let r = 0; r < ROWS; r++) {
		for (let c = 0; c < COLS; c++) {
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

const UA =
	"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";

async function fetchSearch(url: string): Promise<{
	results: any[];
	cursors: string[];
} | null> {
	const res = await fetch(url, {
		headers: { "user-agent": UA, accept: "text/html", "accept-language": "pl-PL,pl;q=0.9" },
	});
	if (res.status !== 200) {
		console.log(`  http ${res.status} for ${new URL(url).searchParams.get("d")}/${url.slice(30, 70)}`);
		return null;
	}
	const html = await res.text();
	const m = html.match(
		/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/,
	);
	if (!m) return null;
	let raw = m[1];
	if (raw.startsWith("%")) {
		try { raw = decodeURIComponent(raw); } catch {}
	}
	const data = JSON.parse(raw);
	const findKey = (n: any, key: string): any => {
		if (!n || typeof n !== "object") return null;
		if (Array.isArray(n)) {
			for (const v of n) { const r = findKey(v, key); if (r) return r; }
			return null;
		}
		if (key in n) return n[key];
		for (const v of Object.values(n)) { const r = findKey(v, key); if (r) return r; }
		return null;
	};
	return {
		results: findKey(data, "searchResults") ?? [],
		cursors: (findKey(data, "pageCursors") as string[]) ?? [],
	};
}

const seen = new Set<string>();
let requests = 0;
let saturatedLeaves = 0;
let deepest = 0;

async function drainTile(t: Tile): Promise<number> {
	let uniques = 0;
	let cursor: string | undefined;
	let saturated = false;
	for (;;) {
		if (requests >= maxRequests || seen.size >= 100000) return uniques;
		requests++;
		const page = await fetchSearch(tileUrl(t, cursor));
		if (!page) return uniques;
		for (const r of page.results) {
			const id = r?.demandStayListing?.id;
			if (id && !seen.has(id)) {
				seen.add(id);
				uniques++;
			}
		}
		const idx = cursor ? page.cursors.indexOf(cursor) : -1;
		const next = page.cursors[idx + 1]; // page 1 -> cursors[0]
		if (next) {
			cursor = next;
			await new Promise((res) => setTimeout(res, 900));
			continue;
		}
		// Chain end: saturated when the cursor list hit the cap and the
		// last page was still full (Airbnb truncates, not empties).
		saturated =
			page.cursors.length >= CURSOR_CAP && page.results.length >= PAGE_FULL;
		break;
	}
	if (saturated && t.depth < MAX_DEPTH) {
		saturatedLeaves++;
		deepest = Math.max(deepest, t.depth + 1);
		console.log(
			`split ${t.name} at depth ${t.depth} (bbox lat ${t.minLat.toFixed(3)}..${t.maxLat.toFixed(3)}, lng ${t.minLng.toFixed(3)}..${t.maxLng.toFixed(3)})`,
		);
		const midLat = (t.minLat + t.maxLat) / 2;
		const midLng = (t.minLng + t.maxLng) / 2;
		const quads: Array<[number, number, number, number]> = [
			[midLat, t.maxLat, midLng, t.maxLng],
			[midLat, t.maxLat, t.minLng, midLng],
			[t.minLat, midLat, midLng, t.maxLng],
			[t.minLat, midLat, t.minLng, midLng],
		];
		let qi = 0;
		for (const [a, b, c, d] of quads) {
			qi++;
			await drainTile({
				name: `${t.name}${qi}`,
				minLat: a, maxLat: b, minLng: c, maxLng: d,
				depth: t.depth + 1,
			});
			if (requests >= maxRequests) break;
		}
	}
	void saturated;
	return uniques;
}

console.log(`probe quadtree: tile filter=${argTile ?? "all"} budget=${maxRequests} req`);
const roots = baseTiles().filter((t) => {
	if (!argTile) return true;
	const [c, r] = argTile.split(",").map(Number);
	return t.name === `t${r}-${c}`;
});

const t0 = Date.now();
for (const root of roots) {
	const u = await drainTile(root);
	console.log(
		`root ${root.name}: ${u} new uniques (total ${seen.size}) after ${requests} req`,
	);
	if (requests >= maxRequests) break;
}
console.log(
	`DONE uniques=${seen.size} requests=${requests} saturatedLeaves=${saturatedLeaves} deepest=${deepest} elapsed=${((Date.now() - t0) / 1000).toFixed(0)}s`,
);

export {};
