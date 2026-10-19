import { spawn } from "node:child_process";
import { resolve } from "node:path";
import "nitro/types";
import { definePlugin } from "nitro";

/**
 * On dev server start, kick off a background data refresh so the app boots
 * with current offers. Dev runs are diff-only (each site loads just what was
 * added since its last successful crawl, capped at 7 days of history).
 * Production relies on the hourly scheduled task instead (same `refresh`
 * task, wired in vite.config.ts).
 *
 * The crawl runs in a *child* process, not via `runTask` in this one: the
 * crawler graph is loaded through Vite's dev module runner, and that first
 * load blocks the server's event loop for minutes on a cold start (every
 * page request queues behind it). `server/boot-refresh.ts` pays that cost in
 * its own process; live progress reaches /api/crawl-status through
 * `data/crawler/refresh.json` (src/crawler/refresh-lock.ts).
 */
export default definePlugin(() => {
	if (!import.meta.dev) return;
	console.log(
		"[refresh] dev server started; running incremental crawl in a child process...",
	);
	const script = resolve(process.cwd(), "server/boot-refresh.ts");
	const child = spawn(process.execPath, ["--import", "tsx", script], {
		cwd: process.cwd(),
		stdio: "inherit",
		env: process.env,
	});
	child.on("error", (err) => {
		console.error("[refresh] could not start the dev crawl:", err);
	});
	// The crawl must not outlive the server it belongs to.
	process.once("exit", () => child.kill());
});
