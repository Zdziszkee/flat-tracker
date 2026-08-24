import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { getProgress, isRunning } from "#/crawler/progress";

/**
 * Kick off a full data refresh from the UI. Runs in the background; the
 * /sources page then polls /api/crawl-status for live per-source progress.
 */
export const Route = createFileRoute("/api/refresh")({
	server: {
		handlers: {
			POST: async () => {
				if (isRunning()) {
					return json({
						started: false,
						alreadyRunning: true,
						runId: getProgress()?.runId ?? null,
					});
				}
				// Lazy-import so the crawler graph (crawlee/playwright) is not
				// bundled into the SSR route chunk: it references `__dirname`,
				// which crashes the production ESM bundle when eagerly loaded.
				const { refreshAll } = await import("#/crawler/refresh");
				void refreshAll()
					.then((summary) => {
						const ok = summary.sites.filter((s) => s.ok).length;
						console.log(
							`[refresh] manual: ${ok}/${summary.sites.length} sites ok, ` +
								`${summary.pruned} pruned, ${summary.rcnNew} new RCN, ` +
								`${summary.geocoded} geocoded`,
						);
					})
					.catch((err) => console.error("[refresh] manual failed:", err));
				return json({ started: true, alreadyRunning: false });
			},
		},
	},
});
