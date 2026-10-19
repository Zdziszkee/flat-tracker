import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { RefreshPhase, SourceProgress } from "./progress.ts";

/**
 * Cross-process refresh state for the dev-start crawl.
 *
 * The dev server must stay responsive, so its boot refresh runs in a child
 * process (`server/boot-refresh.ts`, spawned by
 * `server/plugins/refresh-on-start.ts`). This module is the only thing the
 * two processes share:
 *
 * - the child publishes its live progress here, so /api/crawl-status can show
 *   it even though the in-memory registry lives in the other process;
 * - every refresh entry point consults it before starting, so a manual or
 *   hourly run cannot overlap the child's crawl (the in-memory `isRunning()`
 *   guard only covers one process).
 *
 * The record is deliberately treated as ephemeral: a dead pid or a record
 * that has not been touched for `STALE_MS` is ignored, so a crashed child can
 * never wedge future refreshes.
 */

export const REFRESH_LOCK_PATH = "data/crawler/refresh.json";

/** The child rewrites the record every second; this is ~90 s of slack. */
const STALE_MS = 90_000;

export interface RemoteRefresh {
	pid: number;
	runId: string;
	status: "running" | "done";
	startedAt: string;
	finishedAt?: string;
	phase: RefreshPhase;
	sources: SourceProgress[];
	updatedAt: string;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to another user.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function readRefreshLock(): RemoteRefresh | null {
	try {
		const raw = JSON.parse(
			readFileSync(REFRESH_LOCK_PATH, "utf8"),
		) as RemoteRefresh;
		if (typeof raw?.pid !== "number" || typeof raw?.updatedAt !== "string") {
			return null;
		}
		return raw;
	} catch {
		return null;
	}
}

/**
 * Publish a record. Written to a sibling temp file and renamed so a reader
 * never observes a half-written JSON document.
 */
export function writeRefreshLock(record: RemoteRefresh): void {
	try {
		mkdirSync(dirname(REFRESH_LOCK_PATH), { recursive: true });
		const tmp = `${REFRESH_LOCK_PATH}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(record));
		renameSync(tmp, REFRESH_LOCK_PATH);
	} catch {
		// Progress publishing is best-effort; never fail a crawl over it.
	}
}

export function clearRefreshLock(pid = process.pid): void {
	const record = readRefreshLock();
	if (record && record.pid !== pid) return;
	try {
		unlinkSync(REFRESH_LOCK_PATH);
	} catch {
		// already gone
	}
}

/** The refresh owned by *another* live process, or null. */
export function remoteRefreshRunning(): RemoteRefresh | null {
	const record = readRefreshLock();
	if (!record || record.status !== "running" || record.pid === process.pid) {
		return null;
	}
	if (!isProcessAlive(record.pid)) return null;
	const updated = Date.parse(record.updatedAt);
	if (!Number.isFinite(updated) || Date.now() - updated > STALE_MS) return null;
	return record;
}

/** Cross-process single-flight guard: true when a child crawl is underway. */
export function refreshLockedByOther(): boolean {
	return remoteRefreshRunning() != null;
}
