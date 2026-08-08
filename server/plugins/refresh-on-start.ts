import "nitro/types";
import { definePlugin } from "nitro";
import { runTask } from "nitro/task";

/**
 * On dev server start, kick off a full data refresh in the background so
 * the app boots with current offers. Production relies on the hourly
 * scheduled task instead (same `refresh` task, wired in vite.config.ts).
 */
export default definePlugin(() => {
	if (!import.meta.dev) return;
	console.log(
		"[refresh] dev server started; running initial crawl in the background...",
	);
	void runTask("refresh").catch((err) => {
		console.error("[refresh] startup crawl failed:", err);
	});
});
