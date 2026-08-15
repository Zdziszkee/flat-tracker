import "nitro/types";
import { definePlugin } from "nitro";
import { runTask } from "nitro/task";

/**
 * On dev server start, kick off a background data refresh so the app
 * boots with current offers. Dev runs are diff-only (each site loads just
 * what was added since its last successful crawl, capped at 7 days of
 * history). Production relies on the hourly scheduled task instead (same
 * `refresh` task, wired in vite.config.ts).
 */
export default definePlugin(() => {
	if (!import.meta.dev) return;
	console.log(
		"[refresh] dev server started; running incremental crawl in the background...",
	);
	void runTask("refresh", { payload: { mode: "dev" } }).catch((err) => {
		console.error("[refresh] startup crawl failed:", err);
	});
});
