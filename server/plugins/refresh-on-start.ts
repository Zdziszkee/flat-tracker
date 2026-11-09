import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "nitro/types";
import { definePlugin } from "nitro";

/**
 * A boot crawl saturates CPU/SQLite at exactly the moment the first page is
 * compiled and opened, which made `bun run dev` feel like the app was broken.
 * Let the first visit land first; skip entirely when a crawl finished in the
 * last 30 minutes.
 */
const BOOT_CRAWL_DELAY_MS = 20_000;
const RECENT_CRAWL_WINDOW_MS = 30 * 60_000;

function crawledRecently(): boolean {
	try {
		const state = JSON.parse(
			readFileSync(resolve(process.cwd(), "data/crawler/state.json"), "utf8"),
		) as Record<string, string>;
		const newest = Math.max(
			0,
			...Object.values(state).map((value) => new Date(value).getTime() || 0),
		);
		return Date.now() - newest < RECENT_CRAWL_WINDOW_MS;
	} catch {
		return false;
	}
}

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
		`[refresh] dev server started; incremental crawl in ${BOOT_CRAWL_DELAY_MS / 1000}s unless one just ran...`,
	);
	let child: ReturnType<typeof spawn> | null = null;
	const timer = setTimeout(() => {
		if (crawledRecently()) {
			console.log("[refresh] a crawl ran recently; skipping the dev-boot crawl");
			return;
		}
		const script = resolve(process.cwd(), "server/boot-refresh.ts");
		child = spawn(process.execPath, ["--import", "tsx", script], {
			cwd: process.cwd(),
			stdio: "inherit",
			env: process.env,
		});
		child.on("error", (err) => {
			console.error("[refresh] could not start the dev crawl:", err);
		});
	}, BOOT_CRAWL_DELAY_MS);
	// The crawl must not outlive the server it belongs to.
	process.once("exit", () => {
		clearTimeout(timer);
		child?.kill();
	});
});
