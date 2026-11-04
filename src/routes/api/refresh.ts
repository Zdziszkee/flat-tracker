import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { getProgress, isRunning } from "#/crawler/progress";
import {
	refreshLockedByOther,
	remoteRefreshRunning,
} from "#/crawler/refresh-lock";

/**
 * Kick off a full data refresh from the UI. Runs in the background; the
 * /sources page then polls /api/crawl-status for live per-source progress.
 *
 * The crawl never executes in this process: `refreshAll()` loads the crawler
 * graph (Crawlee, Playwright, better-sqlite3, Effect) and has long synchronous
 * SQLite phases, so running it here froze the whole UI while the dev server
 * was Vite's module runner. It runs in `server/refresh-child.ts` instead and
 * reports progress through `data/crawler/refresh.json` (see
 * `src/crawler/refresh-lock.ts`). Only a deployment without the TS runner
 * (a built `.output/` without `server/` or `tsx`) falls back to an in-process
 * run.
 */
export const Route = createFileRoute("/api/refresh")({
	server: {
		handlers: {
			POST: async () => {
				const busy = () => {
					const remote = remoteRefreshRunning();
					return json({
						started: false,
						alreadyRunning: true,
						runId: getProgress()?.runId ?? remote?.runId ?? null,
					});
				};

				// A dev-boot crawl lives in a child process; `isRunning()` only
				// sees this one, so the shared lock is checked too.
				if (isRunning() || remoteRefreshRunning()) return busy();

				// Lazy-import so the spawn helper (and `node:child_process`) is
				// not pulled into the route's server chunk until needed.
				const { canSpawnRefreshProcess, spawnRefreshProcess } = await import(
					"#/crawler/refresh-process"
				);
				// Re-check after the (async) import: a concurrent POST may have
				// started a refresh while this handler was loading the module.
				if (isRunning() || remoteRefreshRunning()) return busy();

				if (canSpawnRefreshProcess()) {
					const pid = spawnRefreshProcess({ label: "manual" });
					if (!pid) {
						// Another run took the lock between the check and the spawn.
						if (remoteRefreshRunning()) return busy();
						return json(
							{ started: false, alreadyRunning: false },
							{ status: 500 },
						);
					}
					return json({ started: true, alreadyRunning: false });
				}

				// Fallback: deployment without the TS child runner. The crawler
				// graph is already bundled in prod, so the import is cheap there;
				// this path is never taken by `bun run dev`.
				const { refreshAll } = await import("#/crawler/refresh");
				if (isRunning() || refreshLockedByOther()) return busy();
				void refreshAll()
					.then((summary) => {
						const ok = summary.sites.filter((s) => s.ok).length;
						console.log(
							`[refresh] manual: ${ok}/${summary.sites.length} sites ok, ` +
								`${summary.pruned} pruned, ${summary.rcnNew} new RCN, ` +
								`${summary.gugikNew} new GUGiK, ${summary.geocoded} geocoded`,
						);
					})
					.catch((err) => console.error("[refresh] manual failed:", err));
				return json({ started: true, alreadyRunning: false });
			},
		},
	},
});
