import "nitro/types";
import { defineTask } from "nitro/task";

import { DEV_SINCE_DAYS } from "#/crawler/refresh-options";

/**
 * Data refresh task (hourly cron "0 * * * *" via scheduledTasks in
 * vite.config.ts). The crawl runs in `server/refresh-child.ts`, never in the
 * server process: loading the crawler graph and the synchronous SQLite/RBush
 * phases would block every HTTP request. The child publishes live progress to
 * `data/crawler/refresh.json`. Also invocable manually:
 * POST /_nitro/tasks/refresh or `nitro task run refresh`.
 *
 * Payload modes:
 * - `{ mode: "dev" }`: diff-only, 7-day window — each site fetches only
 *   offers added since its last successful crawl (manual invocations).
 * - no mode (hourly cron): full window (90 days).
 */
interface RefreshTaskResult {
	started: boolean;
	alreadyRunning: boolean;
	pid?: number;
	summary?: unknown;
}

export default defineTask({
	meta: {
		name: "refresh",
		description: "Crawl all sources, prune stale offers, import RCN diff",
	},
	run: async ({ payload }): Promise<{ result: RefreshTaskResult }> => {
		const dev = payload?.mode === "dev";
		const { canSpawnRefreshProcess, spawnRefreshProcess } = await import(
			"#/crawler/refresh-process"
		);
		const { remoteRefreshRunning } = await import("#/crawler/refresh-lock");

		if (canSpawnRefreshProcess()) {
			if (remoteRefreshRunning() != null) {
				return { result: { started: false, alreadyRunning: true } };
			}
			const pid = spawnRefreshProcess({
				label: dev ? "task-dev" : "task",
				diffOnly: dev,
				sinceDays: dev ? DEV_SINCE_DAYS : undefined,
			});
			return {
				result: { started: pid != null, alreadyRunning: false, pid },
			};
		}

		// Fallback: deployment without the TS child runner (a built `.output/`
		// stripped of `server/` or `tsx`). The server bundle already contains
		// the crawler graph there, so an in-process run is the only option.
		const { refreshAll } = await import("#/crawler/refresh");
		const summary = await refreshAll(
			dev ? { sinceDays: DEV_SINCE_DAYS, diffOnly: true } : {},
		);
		const ok = summary.sites.filter((s) => s.ok).length;
		console.log(
			`[refresh${dev ? " dev" : ""}] ${ok}/${summary.sites.length} sites crawled in ` +
				`${summary.elapsedSeconds.toFixed(1)}s, ${summary.pruned} pruned, ` +
				`${summary.rcnNew} new RCN transactions, ` +
				`${summary.geocoded} geocoded`,
		);
		return { result: { started: true, alreadyRunning: false, summary } };
	},
});
