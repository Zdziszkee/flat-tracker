/**
 * Tiny in-process cache for the expensive read-only analytics endpoints.
 *
 * Those handlers run heavy SQLite aggregations over the 24M-row transaction
 * table (and, for the choropleth, a JS point-in-polygon pass). better-sqlite3
 * is synchronous, so every request blocked the server's event loop for its
 * whole duration. The data only changes when the hourly crawl does, so a few
 * minutes of reuse is free correctness-wise and keeps repeat visits instant.
 *
 * Single-flight: concurrent requests for the same key share one computation
 * instead of each starting the same multi-second query.
 */

interface Entry {
	value: unknown;
	expiresAt: number;
	pending?: Promise<unknown>;
}

const store = new Map<string, Entry>();

export async function withCache<T>(
	key: string,
	ttlMs: number,
	compute: () => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const hit = store.get(key);
	if (hit && hit.expiresAt > now) return hit.value as T;
	if (hit?.pending) return hit.pending as Promise<T>;

	const pending = compute()
		.then((value) => {
			store.set(key, { value, expiresAt: Date.now() + ttlMs });
			return value;
		})
		.catch((err) => {
			// A failed computation must not be cached; the next request retries.
			store.delete(key);
			throw err;
		});

	store.set(key, {
		value: hit?.value,
		expiresAt: now + ttlMs,
		pending,
	});
	return pending;
}

/** Drop one key (or everything) after a crawl/import changed the data. */
export function invalidateCache(key?: string): void {
	if (key === undefined) store.clear();
	else store.delete(key);
}
