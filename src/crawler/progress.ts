/**
 * In-memory registry of the current data-refresh run, shared between the
 * crawler (`refreshAll`) and the `/api/crawl-status` endpoint.
 *
 * Nitro runs the server in a single Node process, so a module-level
 * singleton is safe across requests. It resets on restart, which is fine:
 * this only exists to show *live* progress while a refresh is underway.
 * Durable "when was each source last refreshed" lives in `crawl_runs`.
 */

type SourceRunState = "pending" | "running" | "ok" | "failed";

export interface SourceProgress {
	source: string;
	state: SourceRunState;
	startedAt?: string;
	finishedAt?: string;
	pages?: number;
	newCount?: number;
	updatedCount?: number;
	error?: string;
}

export type RefreshPhase =
	| "crawl"
	| "prune"
	| "airbnb-enrich"
	| "geocode"
	| "rcn"
	| "building-assign"
	| "done";

export interface RefreshProgress {
	runId: string;
	status: "running" | "done";
	startedAt: string;
	finishedAt?: string;
	phase: RefreshPhase;
	sources: SourceProgress[];
}

let current: RefreshProgress | null = null;
let runCounter = 0;

/** Snapshot of the in-flight run, or null when idle. */
export function getProgress(): RefreshProgress | null {
	return current;
}

/** Whether a refresh is currently in flight (single-flight guard). */
export function isRunning(): boolean {
	return current != null;
}

export function beginRefresh(sourceIds: string[]): RefreshProgress {
	runCounter += 1;
	current = {
		runId: `${Date.now()}-${runCounter}`,
		status: "running",
		startedAt: new Date().toISOString(),
		phase: "crawl",
		sources: sourceIds.map((source) => ({ source, state: "pending" })),
	};
	return current;
}

export function setPhase(phase: RefreshPhase): void {
	if (current) current.phase = phase;
}

export function setSourceProgress(
	source: string,
	patch: Partial<Omit<SourceProgress, "source">>,
): void {
	if (!current) return;
	const entry = current.sources.find((s) => s.source === source);
	if (entry) Object.assign(entry, patch);
}

/** Clear the in-flight registry; durable results are in `crawl_runs`. */
export function endRefresh(): void {
	if (current) {
		current.status = "done";
		current.phase = "done";
		current.finishedAt = new Date().toISOString();
	}
	current = null;
}
