import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Listing } from "../types.ts";

/**
 * Persistent detail-page cache shared by the portal adapters.
 *
 * Several adapters enrich list rows from a detail page (a posting date,
 * coordinates, a unit inventory, a construction timeline) and must not
 * refetch the same page on every hourly run. Each keeps a small JSON map
 * keyed by its own id; this module owns the load/save/freshness rules and
 * the per-list-page request budget, so an adapter declares only its entry
 * shape and what to re-apply to a list row.
 *
 * The map is loaded once per process and written back whole, as before.
 */
export interface DetailCacheEntry {
	fetchedAt: string;
}

export interface DetailCacheConfig<T extends DetailCacheEntry> {
	/** JSON file, or a getter for a path an env var can override. */
	path: string | (() => string);
	/** Days a fetched entry stays usable. Omit for entries that never expire. */
	ttlDays?: number;
	/**
	 * Coerce one stored entry into `T` (an older file may miss fields).
	 * Return null to drop it. Default: trust the file as written.
	 */
	normalize?: (raw: Record<string, unknown>) => T | null;
}

export interface DetailCache<T extends DetailCacheEntry> {
	load(): Record<string, T>;
	save(cache: Record<string, T>): void;
	get(id: string): T | undefined;
	/** Entry exists, has a parseable `fetchedAt`, and is inside the TTL. */
	fresh(entry: T | undefined): boolean;
	/** Record one freshly fetched entry and persist the cache. */
	store(id: string, entry: Omit<T, "fetchedAt">): void;
	/** Store an entry that already carries its own fetch stamp. */
	put(id: string, entry: T): void;
}

export function createDetailCache<T extends DetailCacheEntry>(
	config: DetailCacheConfig<T>,
): DetailCache<T> {
	let state: Record<string, T> | null = null;

	const cachePath = (): string =>
		typeof config.path === "function" ? config.path() : config.path;

	const resolve = (raw: unknown): T | null => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
		const record = raw as Record<string, unknown>;
		return config.normalize ? config.normalize(record) : (record as T);
	};

	const load = (): Record<string, T> => {
		if (state) return state;
		let parsed: Record<string, unknown> = {};
		try {
			const raw: unknown = JSON.parse(readFileSync(cachePath(), "utf8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				parsed = raw as Record<string, unknown>;
			}
		} catch {
			// Missing or corrupt cache: start empty, details simply re-fetch.
		}
		const cache: Record<string, T> = {};
		for (const [id, entry] of Object.entries(parsed)) {
			const resolved = resolve(entry);
			if (resolved) cache[id] = resolved;
		}
		state = cache;
		return cache;
	};

	const save = (cache: Record<string, T>): void => {
		state = cache;
		const path = cachePath();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(cache));
	};

	return {
		load,
		save,
		get(id) {
			return load()[id];
		},
		fresh(entry) {
			if (!entry?.fetchedAt) return false;
			const fetched = Date.parse(entry.fetchedAt);
			if (!Number.isFinite(fetched)) return false;
			if (config.ttlDays == null) return true;
			return Date.now() - fetched < config.ttlDays * 86_400_000;
		},
		store(id, entry) {
			const cache = load();
			cache[id] = { ...entry, fetchedAt: new Date().toISOString() } as T;
			save(cache);
		},
		put(id, entry) {
			const cache = load();
			cache[id] = entry;
			save(cache);
		},
	};
}

export interface DetailPassOptions<T extends DetailCacheEntry> {
	/** Max uncached detail URLs to enqueue for one list page. */
	budget: number;
	/** Cached entries that must be refetched despite being present. */
	usable?: (entry: T) => boolean;
	/**
	 * Re-apply a cached entry onto its list row, so a list-only crawl cannot
	 * wipe the detail fields. Cached rows never spend the request budget.
	 */
	apply?: (listing: Listing, entry: T) => void;
}

/**
 * Merge cached details into a list page's rows and return the detail URLs
 * still worth fetching, capped at the page's budget. Callers enqueue the
 * result; an empty array means this page is fully enriched.
 */
export function enqueueDetailPass<T extends DetailCacheEntry>(
	listings: Listing[],
	cache: Record<string, T>,
	options: DetailPassOptions<T>,
): string[] {
	const urls: string[] = [];
	for (const listing of listings) {
		const cached = cache[listing.externalId];
		if (cached && (options.usable ? options.usable(cached) : true)) {
			options.apply?.(listing, cached);
			continue;
		}
		if (urls.length >= options.budget) continue;
		if (listing.url) urls.push(listing.url);
	}
	return urls;
}
