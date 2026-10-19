/**
 * Dev-start crawl, run as a child process by
 * `server/plugins/refresh-on-start.ts`.
 *
 * Why a child: the crawler graph (Crawlee, Playwright/camoufox, the RCN
 * importers) is loaded through Vite's dev module runner, and the first load
 * of that graph blocks the server's event loop for minutes on a cold start —
 * every page request queues behind it. Running the crawl here keeps the dev
 * server instant: this process pays the module-load and SQLite cost, the
 * server only answers requests.
 *
 * `data/crawler/refresh.json` is the shared state (see
 * `src/crawler/refresh-lock.ts`): live progress for /api/crawl-status and the
 * cross-process single-flight guard for the server's own refresh entry
 * points.
 *
 *   node --import tsx server/boot-refresh.ts
 */
import { getProgress } from "#/crawler/progress";
import {
	clearRefreshLock,
	remoteRefreshRunning,
	writeRefreshLock,
} from "#/crawler/refresh-lock";

const startedAt = new Date().toISOString();

// Take the lock before the heavy import: a second boot (Vite restarts after
// dependency optimization) must see this run and exit instead of crawling
// everything twice.
const existing = remoteRefreshRunning();
if (existing) {
	console.log(
		`[refresh] ${existing.pid} is already crawling (${existing.phase}); not starting another dev refresh`,
	);
	process.exit(0);
}

writeRefreshLock({
	pid: process.pid,
	runId: `${startedAt}-boot`,
	status: "running",
	startedAt,
	phase: "crawl",
	sources: [],
	updatedAt: startedAt,
});

const timer = setInterval(() => {
	const progress = getProgress();
	writeRefreshLock({
		pid: process.pid,
		runId: progress?.runId ?? `${startedAt}-boot`,
		status: "running",
		startedAt: progress?.startedAt ?? startedAt,
		phase: progress?.phase ?? "crawl",
		sources: progress?.sources ?? [],
		updatedAt: new Date().toISOString(),
	});
}, 1000);
timer.unref();

try {
	// Imported after the lock is taken: this is the slow module graph.
	const { refreshAll, DEV_SINCE_DAYS } = await import("#/crawler/refresh");
	const summary = await refreshAll({ sinceDays: DEV_SINCE_DAYS, diffOnly: true });
	const ok = summary.sites.filter((s) => s.ok).length;
	console.log(
		`[refresh dev] ${ok}/${summary.sites.length} sites crawled in ` +
			`${summary.elapsedSeconds.toFixed(1)}s, ${summary.pruned} pruned, ` +
			`${summary.rcnNew} new RCN transactions, ${summary.geocoded} geocoded`,
	);
	writeRefreshLock({
		pid: process.pid,
		runId: `${startedAt}-boot`,
		status: "done",
		startedAt: summary.startedAt,
		finishedAt: new Date().toISOString(),
		phase: "done",
		sources: [],
		updatedAt: new Date().toISOString(),
	});
} catch (err) {
	console.error("[refresh] startup crawl failed:", err);
	clearRefreshLock();
	process.exitCode = 1;
} finally {
	clearInterval(timer);
}
