/**
 * Refresh window constants that every entry point shares.
 *
 * Kept in their own module so the server-side spawners can read the defaults
 * without importing `refresh.ts` (which pulls the whole crawler graph into the
 * HTTP server process).
 */

/** Full refresh window (the hourly cron and a manual refresh). */
export const DEFAULT_SINCE_DAYS = 90;

/** Dev-start diff window: never go further back than this. */
export const DEV_SINCE_DAYS = 7;
