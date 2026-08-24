import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { getProgress, isRunning } from "#/crawler/progress";
import { refreshAll } from "#/crawler/refresh";

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
