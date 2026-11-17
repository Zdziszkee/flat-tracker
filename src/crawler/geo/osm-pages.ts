/**
 * Cursor-paged reads of the `osm_buildings` table.
 *
 * The index holds every addressed footprint in małopolskie + śląskie
 * (~3.2M rows). A single `select()` materialises every row object at once,
 * which blocks the server event loop and adds hundreds of megabytes of
 * short-lived garbage. Callers page by the integer primary key and yield
 * between pages so queued HTTP work can run.
 */

/** Rows per page: one page parses in a short, non-blocking slice. */
export const OSM_PAGE_SIZE = 50_000;

/** Let queued HTTP work run between pages of a background build. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Walk `osm_buildings` in ascending `id` order, one page at a time.
 * `selectPage` receives the last id seen (0 for the first page) and a row
 * limit; `onPage` processes each batch before the next query. Stops on the
 * first empty page.
 */
export async function forEachOsmBuildingPage<Row extends { id: number }>(
	selectPage: (afterId: number, limit: number) => Promise<Row[]>,
	onPage: (rows: Row[]) => void | Promise<void>,
): Promise<void> {
	let cursor = 0;
	for (;;) {
		const rows = await selectPage(cursor, OSM_PAGE_SIZE);
		if (rows.length === 0) break;
		await onPage(rows);
		cursor = rows[rows.length - 1].id;
		await yieldToEventLoop();
	}
}
