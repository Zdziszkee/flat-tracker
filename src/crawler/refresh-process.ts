/**
 * Spawn an out-of-process refresh (`server/refresh-child.ts`).
 *
 * The HTTP server must never run a crawl itself: loading the crawler graph
 * through Vite's dev module runner blocks the event loop for minutes, and the
 * refresh's synchronous SQLite/RBush phases (prunes, RCN import, building
 * assignment, price indices) stall every request. The child publishes live
 * progress to `data/crawler/refresh.json`, which `/api/crawl-status` reads.
 *
 * The child is `node --import tsx <script>`; `tsx` and the script both live in
 * the repo. When either is missing (a deployment that ships only the built
 * `.output/`), `canSpawnRefreshProcess()` is false and callers fall back to
 * running `refreshAll()` in-process.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { clearRefreshLock, writeRefreshLock } from "./refresh-lock.ts";

export interface SpawnRefreshOptions {
	/** Shown in log lines and in the published run id ("manual", "dev-boot"). */
	label: string;
	sinceDays?: number;
	diffOnly?: boolean;
	firstPageOnly?: boolean;
	includeRcn?: boolean;
}

function childScriptPath(): string {
	return resolve(process.cwd(), "server/refresh-child.ts");
}

/** Whether this deployment can run the crawler in a child process. */
export function canSpawnRefreshProcess(): boolean {
	if (!existsSync(childScriptPath())) return false;
	try {
		createRequire(import.meta.url).resolve("tsx");
		return true;
	} catch {
		return false;
	}
}

/**
 * Start the refresh child and return its pid. Progress and the single-flight
 * guard travel through `data/crawler/refresh.json`; the caller returns
 * immediately.
 */
export function spawnRefreshProcess(
	options: SpawnRefreshOptions,
): number | undefined {
	const args = [
		"--import",
		"tsx",
		childScriptPath(),
		`--label=${options.label}`,
	];
	if (options.diffOnly) args.push("--diff-only");
	if (options.sinceDays != null) args.push(`--since-days=${options.sinceDays}`);
	if (options.firstPageOnly === false) args.push("--full-crawl");
	if (options.includeRcn === false) args.push("--no-rcn");

	const child = spawn(process.execPath, args, {
		cwd: process.cwd(),
		stdio: "inherit",
		detached: true,
		env: process.env,
	});

	const startedAt = new Date().toISOString();
	const runId = `${startedAt}-${options.label}`;
	if (child.pid) {
		// Publish the child's pid now: its own first write is a module load
		// away, and a concurrent POST / boot crawl must see this run instead
		// of starting a second one.
		writeRefreshLock({
			pid: child.pid,
			runId,
			status: "running",
			startedAt,
			phase: "crawl",
			sources: [],
			updatedAt: startedAt,
		});
	}
	child.on("error", (err) => {
		console.error(`[refresh] could not start the ${options.label} crawl:`, err);
		if (child.pid) clearRefreshLock(child.pid);
	});
	// The server must not stay alive just because a crawl is running.
	child.unref();
	return child.pid;
}
