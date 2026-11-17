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

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function withCache<T>(
	key: string,
	ttlMs: number,
	compute: () => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const hit = store.get(key);
	// Check the in-flight computation first: a pending entry carries the
	// previous value (or undefined on a cold cache), so returning it here is
	// what made a concurrent /api/market-charts request 500 in Response.json.
	if (hit?.pending) return hit.pending as Promise<T>;
	if (hit && hit.expiresAt > now) return hit.value as T;

	const pending = compute()
		.then((value) => {
			if (value === undefined) {
				store.delete(key);
				throw new Error(`withCache("${key}") returned undefined`);
			}
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

/**
 * Cache a JSON object feed and validate it before it reaches `Response.json`.
 *
 * `Response.json(undefined)` throws "Value is not JSON serializable", and a
 * value poisoned by a failed compute or a hot reload would otherwise stay in
 * the cache for the whole TTL. Validate on write and on read, then retry once
 * after evicting a bad entry so a transient value never becomes a 500.
 */
export async function withJsonObjectCache<T extends object>(
	key: string,
	ttlMs: number,
	compute: () => Promise<T>,
): Promise<T> {
	const validate = (value: unknown): T => {
		if (!isJsonObject(value)) {
			throw new Error(`Cached JSON feed "${key}" is not an object`);
		}
		// Response.json only rejects top-level undefined/functions; this also
		// catches nested BigInts and cycles before the response is built.
		JSON.stringify(value);
		return value as T;
	};
	const computeJson = async (): Promise<T> => validate(await compute());
	const read = (): Promise<T> =>
		withCache(key, ttlMs, computeJson).then(validate);

	try {
		return await read();
	} catch {
		invalidateCache(key);
		return read();
	}
}

/** Drop one key (or everything) after a crawl/import changed the data. */
export function invalidateCache(key?: string): void {
	if (key === undefined) store.clear();
	else store.delete(key);
}
