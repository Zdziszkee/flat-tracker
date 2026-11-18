/**
 * Spawn the daily scoring run out of process.
 *
 * The score run opens better-sqlite3 and builds the OSM RBush index. Running
 * it in the HTTP server would block every request for minutes, so the Nitro
 * task starts this child and returns immediately.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export interface SpawnScoreOptions {
	all?: boolean;
	limit?: number;
	days?: number;
	/** Backfill only these listings. */
	listingIds?: readonly number[];
	dryRun?: boolean;
}

const LOCK_PATH = resolve(process.cwd(), "data", "scoring", "score.lock");

function childScriptPath(): string {
	return resolve(process.cwd(), "server", "score-child.ts");
}

export function canSpawnScoreProcess(): boolean {
	if (!existsSync(childScriptPath())) return false;
	try {
		createRequire(import.meta.url).resolve("tsx");
		return true;
	} catch {
		return false;
	}
}

export function scoreRunning(): number | null {
	if (!existsSync(LOCK_PATH)) return null;
	try {
		const pid = Number(readFileSync(LOCK_PATH, "utf8").trim());
		if (!Number.isFinite(pid) || pid <= 0) return null;
		try {
			process.kill(pid, 0);
			return pid;
		} catch {
			// A crash leaves the lock behind. Treat a dead pid as no run.
			return null;
		}
	} catch {
		return null;
	}
}

export function spawnScoreProcess(
	options: SpawnScoreOptions,
): number | undefined {
	if (scoreRunning() != null) return undefined;
	const args = ["--import", "tsx", childScriptPath()];
	if (options.all) args.push("--all");
	if (options.limit != null) args.push(`--limit=${options.limit}`);
	if (options.days != null) args.push(`--days=${options.days}`);
	if (options.listingIds?.length) {
		args.push(`--listing-ids=${options.listingIds.join(",")}`);
	}
	if (options.dryRun) args.push("--dry-run");
	const child = spawn(process.execPath, args, {
		cwd: process.cwd(),
		stdio: "inherit",
		detached: true,
		env: process.env,
	});
	child.unref();
	return child.pid;
}
