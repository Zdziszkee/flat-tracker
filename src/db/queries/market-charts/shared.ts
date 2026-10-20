import { type SQL, sql } from "drizzle-orm";

import { db } from "#/db/index";

/**
 * Shared helpers for the market-chart queries.
 *
 * `all` yields to the event loop between queries: a dashboard refresh is a
 * sequence of synchronous better-sqlite3 aggregations, and without the yield
 * every queued HTTP request waits for the whole feed.
 */
export async function all<T>(query: SQL): Promise<T[]> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	return db.all<T>(query);
}

/** City buckets by lat/lng for rental-market analytics. */
export const CITY_CASE = sql`
	CASE
		WHEN lat BETWEEN 50.02 AND 50.12 AND lng BETWEEN 19.80 AND 20.12 THEN 'Kraków'
		WHEN lat BETWEEN 49.98 AND 50.05 AND lng BETWEEN 20.90 AND 21.05 THEN 'Tarnów'
		WHEN lat BETWEEN 49.58 AND 49.66 AND lng BETWEEN 20.64 AND 20.78 THEN 'Nowy Sącz'
		WHEN lat BETWEEN 49.24 AND 49.34 AND lng BETWEEN 19.88 AND 20.04 THEN 'Zakopane'
		WHEN lat BETWEEN 49.98 AND 50.06 AND lng BETWEEN 19.22 AND 19.38 THEN 'Oświęcim'
		WHEN lat BETWEEN 49.97 AND 50.03 AND lng BETWEEN 20.02 AND 20.11 THEN 'Wieliczka'
		WHEN lat BETWEEN 49.38 AND 49.46 AND lng BETWEEN 20.90 AND 21.02 THEN 'Krynica'
		WHEN lat IS NOT NULL THEN 'reszta'
		ELSE 'brak lokalizacji'
	END
`;

export interface HistogramBucket {
	label: string;
	max: number;
}

/** Cumulative-threshold buckets are converted to non-overlapping counts. */
export function histogram(
	values: readonly number[],
	buckets: readonly HistogramBucket[],
): Array<{ label: string; n: number }> {
	const out = buckets.map((bucket) => ({
		label: bucket.label,
		n: values.filter((value) => value < bucket.max).length,
	}));
	for (let i = out.length - 1; i > 0; i--) {
		out[i].n -= out[i - 1].n;
	}
	return out;
}

export function average(values: readonly number[]): number {
	return Math.round(
		values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length),
	);
}

export function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** `czynsz` from the listings.utilities JSON, or 0 when absent/malformed. */
export function czynszFromUtilities(json: string | null): number {
	if (!json) return 0;
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null) return 0;
		const czynsz = (parsed as { czynsz?: unknown }).czynsz;
		return typeof czynsz === "number" && czynsz > 0 ? czynsz : 0;
	} catch {
		return 0;
	}
}
