import "nitro/types";
import { defineTask } from "nitro/task";

import { DEV_SINCE_DAYS, refreshAll } from "#/crawler/refresh";

/**
 * Data refresh task (hourly cron "0 * * * *" via scheduledTasks in
 * vite.config.ts, plus a manual kick on dev startup). Also invocable
 * manually: POST /_nitro/tasks/refresh or `nitro task run refresh`.
 *
 * Payload modes:
 * - `{ mode: "dev" }` (dev server boot): diff-only, 7-day window —
 *   each site fetches only offers added since its last successful crawl.
 * - no mode (hourly cron): full window (90 days).
 */
export default defineTask({
	meta: {
		name: "refresh",
		description: "Crawl all sources, prune stale offers, import RCN diff",
	},
	run: async ({ payload }) => {
		const dev = payload?.mode === "dev";
		const summary = await refreshAll(
			dev ? { sinceDays: DEV_SINCE_DAYS, diffOnly: true } : {},
		);
		const ok = summary.sites.filter((s) => s.ok).length;
		console.log(
			`[refresh${dev ? " dev" : ""}] ${ok}/${summary.sites.length} sites crawled in ` +
				`${summary.elapsedSeconds.toFixed(1)}s, ${summary.pruned} pruned, ` +
				`${summary.rcnNew} new RCN transactions`,
		);
		return { result: summary };
	},
});
