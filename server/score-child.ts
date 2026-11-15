/**
 * Out-of-process scoring child. Started by `server/tasks/score-listings.ts`
 * through `src/lib/scoring/process.ts`.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { runAlertScoring } from "#/lib/scoring/run";

const STATE_DIR = join(process.cwd(), "data", "scoring");
const LOCK_PATH = join(STATE_DIR, "score.lock");
const LAST_RUN_PATH = join(STATE_DIR, "last-run.json");

function numberArg(name: string): number | undefined {
	const prefix = `--${name}=`;
	const value = process.argv.find((arg) => arg.startsWith(prefix));
	if (!value) return undefined;
	const parsed = Number(value.slice(prefix.length));
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function acquireLock(): boolean {
	mkdirSync(STATE_DIR, { recursive: true });
	if (existsSync(LOCK_PATH)) {
		try {
			const pid = Number(readFileSync(LOCK_PATH, "utf8").trim());
			if (Number.isFinite(pid) && pid > 0) process.kill(pid, 0);
			// The pid is alive: another run owns the lock.
			return false;
		} catch {
			// A stale lock from a crashed run is safe to replace.
			try {
				unlinkSync(LOCK_PATH);
			} catch {
				// another process removed it first
			}
		}
	}
	try {
		const fd = openSync(LOCK_PATH, "wx");
		writeFileSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function releaseLock(): void {
	try {
		unlinkSync(LOCK_PATH);
	} catch {
		// already removed
	}
}

async function main(): Promise<void> {
	if (!acquireLock()) {
		console.log("[score] another scoring run holds the lock; skipping");
		return;
	}
	try {
		const summary = await runAlertScoring({
			all: process.argv.includes("--all"),
			limit: numberArg("limit"),
			days: numberArg("days"),
			dryRun: process.argv.includes("--dry-run"),
		});
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(
			LAST_RUN_PATH,
			JSON.stringify({ ...summary, finishedAt: new Date().toISOString() }, null, 2),
		);
		console.log(
			`[score] scanned=${summary.scanned} scored=${summary.scored} ` +
				`eligible=${summary.eligible} alerts=${summary.alerts} ` +
				`errors=${summary.errors} in ${summary.durationMs}ms`,
		);
	} finally {
		releaseLock();
	}
}

main().catch((error) => {
	console.error("[score] failed:", error);
	releaseLock();
	process.exitCode = 1;
});
