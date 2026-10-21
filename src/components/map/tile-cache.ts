/**
 * Mapbox GL's shared `mapbox-tiles` Cache API entry caches 404 tile
 * responses (their JSON `{"message":"Tile not found"}` body included) and
 * later hands a cached 404 to the vector-tile parser. PBF then throws
 * "Expected varint not more than 10 bytes" for every cached sparse tile.
 *
 * The fetch path handles a live 404 correctly (it renders an empty tile);
 * only the cache read is broken. Drop cached 404s after the initial load
 * and after interactions, and clear the whole tile cache if the parser
 * error still fires.
 */
const CACHE_NAME = "mapbox-tiles";
const MIN_PRUNE_INTERVAL_MS = 4_000;
/** Standard-style sources that legitimately 404 across most of the region. */
const SPARSE_TILE_SOURCES = [
	"hd-road-v1-bounded",
	"indoor-v3",
	"procedural-buildings-v1",
	"mapbox-landmark-pois-v1",
];

let lastPrune = 0;
let pruneInFlight = false;

/** Remove cached 404 responses, keeping valid tiles. Best-effort. */
export function pruneBadTileCache(force = false): void {
	if (typeof caches === "undefined") return;
	const now = Date.now();
	if (!force && now - lastPrune < MIN_PRUNE_INTERVAL_MS) return;
	if (pruneInFlight) return;
	lastPrune = now;
	pruneInFlight = true;
	void (async () => {
		try {
			const cache = await caches.open(CACHE_NAME);
			const requests = (await cache.keys()).filter((request) =>
				SPARSE_TILE_SOURCES.some((source) => request.url.includes(source)),
			);
			await Promise.all(
				requests.map(async (request) => {
					const response = await cache.match(request);
					if (response?.status === 404) await cache.delete(request);
				}),
			);
		} catch {
			// Cache API unavailable or evicted mid-scan: nothing to repair.
		} finally {
			pruneInFlight = false;
		}
	})();
}

/** Nuclear recovery for a cached-404 parse error: refetch every tile. */
export function resetTileCache(): void {
	if (typeof caches === "undefined") return;
	lastPrune = Date.now();
	void caches.delete(CACHE_NAME).catch(() => {
		// Cache API unavailable: the map still refetches from the network.
	});
}
