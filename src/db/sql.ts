import { type SQL, sql } from "drizzle-orm";

/**
 * Shared SQL expressions for the analytics and lookup endpoints. Keeping the
 * price band, date cutoffs, and unix-time formatters here prevents the same
 * literals from drifting across `market-charts`, `valuation`, and the lookup
 * routes.
 */

/** Transactions outside this band are registry typos, not market prices. */
export const PRICE_BAND = { min: 500, max: 40_000 } as const;

/** Unix-seconds cutoff for "the last N days". */
export function daysAgo(days: number, now = Date.now()): number {
	return Math.floor((now - days * 86_400_000) / 1000);
}

export function priceBandClause(column: SQL): SQL {
	return sql`${column} BETWEEN ${PRICE_BAND.min} AND ${PRICE_BAND.max}`;
}

/** `YYYY-MM` from a unix-seconds timestamp column. */
export function monthExpr(column: SQL): SQL {
	return sql`substr(datetime(${column}, 'unixepoch'), 1, 7)`;
}

/** `YYYY` from a unix-seconds timestamp column. */
export function yearExpr(column: SQL): SQL {
	return sql`strftime('%Y', ${column}, 'unixepoch')`;
}

/** `YYYY-MM-DD` from a unix-seconds timestamp column. */
export function dateExpr(column: SQL): SQL {
	return sql`strftime('%Y-%m-%d', ${column}, 'unixepoch')`;
}
