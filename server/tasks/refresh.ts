import "nitro/types";
import { defineTask } from "nitro/task";

import { refreshAll } from "#/crawler/refresh";

/**
 * Hourly data refresh (cron "0 * * * *" via scheduledTasks in
 * vite.config.ts, plus a manual kick on dev startup). Also invocable
 * manually: POST /_nitro/tasks/refresh or `nitro task run refresh`.
 */
export default defineTask({
	meta: {
		name: "refresh",
		description: "Crawl all sources, prune stale offers, import RCN diff",
	},
	run: async () => {
		const summary = await refreshAll();
		const ok = summary.sites.filter((s) => s.ok).length;
		console.log(
			`[refresh] ${ok}/${summary.sites.length} sites crawled in ` +
				`${summary.elapsedSeconds.toFixed(1)}s, ${summary.pruned} pruned, ` +
				`${summary.rcnNew} new RCN transactions`,
		);
		return { result: summary };
	},
});
