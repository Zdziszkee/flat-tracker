/**
 * Out-of-process refresh runner.
 *
 * Loading the crawler graph through Vite's dev module runner blocks the
 * server's event loop for minutes on a cold start, and the later refresh
 * phases (prunes, RCN import, building assignment, price indices) are
 * synchronous better-sqlite3/RBush work that would stall every HTTP request.
 * The dev-boot crawl, the manual "Refresh now" button and the scheduled task
 * therefore run here, in their own process; the server only ever reads the
 * shared record in `data/crawler/refresh.json`.
 *
 * `refreshAll` is imported dynamically *after* the lock is taken: that import
 * is the slow part, and a second runner must see this run instead of crawling
 * everything twice.
 */

import { getProgress } from "./progress.ts";
import {
	clearRefreshLock,
	remoteRefreshRunning,
	writeRefreshLock,
} from "./refresh-lock.ts";
import { DEFAULT_SINCE_DAYS } from "./refresh-options.ts";

export interface RefreshRunOptions {
	/** Shown in log lines and in the published run id ("manual", "dev-boot"). */
	label: string;
	sinceDays?: number;
	diffOnly?: boolean;
	firstPageOnly?: boolean;
	includeRcn?: boolean;
}

/** Exit code: 0 when the run finished (or another run held the lock), 1 on failure. */
export async function runRefreshChild(
	options: RefreshRunOptions,
): Promise<number> {
	const startedAt = new Date().toISOString();
	const runId = `${startedAt}-${options.label}`;

	const existing = remoteRefreshRunning();
	if (existing) {
		console.log(
			`[refresh] ${existing.pid} is already crawling (${existing.phase}); ` +
				`not starting ${options.label}`,
		);
		return 0;
	}

	// Take the lock before the heavy import: a second boot (Vite restarts
	// after dependency optimization) must see this run and exit instead of
	// crawling everything twice.
	writeRefreshLock({
		pid: process.pid,
		runId,
		status: "running",
		startedAt,
		phase: "crawl",
		sources: [],
		updatedAt: startedAt,
	});

	const publish = (status: "running" | "done") => {
		const progress = getProgress();
		writeRefreshLock({
			pid: process.pid,
			runId: progress?.runId ?? runId,
			status,
			startedAt: progress?.startedAt ?? startedAt,
			...(status === "done" ? { finishedAt: new Date().toISOString() } : {}),
			phase: progress?.phase ?? (status === "done" ? "done" : "crawl"),
			sources: progress?.sources ?? [],
			updatedAt: new Date().toISOString(),
		});
	};

	// The server cannot see this process's in-memory progress registry, so
	// republish it every second.
	const timer = setInterval(() => publish("running"), 1000);
	timer.unref();

	try {
		const { refreshAll } = await import("./refresh.ts");
		const summary = await refreshAll({
			sinceDays: options.sinceDays ?? DEFAULT_SINCE_DAYS,
			diffOnly: options.diffOnly,
			firstPageOnly: options.firstPageOnly,
			includeRcn: options.includeRcn,
		});
		const ok = summary.sites.filter((site) => site.ok).length;
		console.log(
			`[refresh ${options.label}] ${ok}/${summary.sites.length} sites ` +
				`crawled in ${summary.elapsedSeconds.toFixed(1)}s, ` +
				`${summary.pruned} pruned, ${summary.rcnNew} new RCN transactions, ` +
				`${summary.gugikNew} new GUGiK, ${summary.geocoded} geocoded`,
		);
		publish("done");
		return 0;
	} catch (err) {
		console.error(`[refresh ${options.label}] failed:`, err);
		clearRefreshLock();
		return 1;
	} finally {
		clearInterval(timer);
	}
}
