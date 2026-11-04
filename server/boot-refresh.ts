/**
 * Dev-start crawl, run as a child process by
 * `server/plugins/refresh-on-start.ts`.
 *
 * Why a child: the crawler graph (Crawlee, Playwright/camoufox, the RCN
 * importers) is loaded through Vite's dev module runner, and the first load
 * of that graph blocks the server's event loop for minutes on a cold start,
 * and the refresh's synchronous SQLite/RBush phases would stall every request
 * afterwards. Running the crawl here keeps the dev server instant: this
 * process pays the module-load and SQLite cost, the server only answers
 * requests.
 *
 * `server/refresh-child.ts` is the shared runner for the boot, manual and
 * scheduled refreshes; `data/crawler/refresh.json` is the shared state (see
 * `src/crawler/refresh-lock.ts`): live progress for /api/crawl-status and the
 * cross-process single-flight guard for the server's own refresh entry
 * points.
 *
 *   node --import tsx server/boot-refresh.ts
 */
import { DEV_SINCE_DAYS } from "#/crawler/refresh-options";
import { runRefreshChild } from "#/crawler/refresh-runner";

process.exitCode = await runRefreshChild({
	label: "dev-boot",
	diffOnly: true,
	sinceDays: DEV_SINCE_DAYS,
});
