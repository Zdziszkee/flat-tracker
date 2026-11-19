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
	/**
	 * Counters of the work inside one phase: offers processed out of the
	 * candidates the phase picked up. The crawler reports pages instead, and a
	 * scrape has no known total, so the two never mix in one row.
	 */
	done?: number;
	total?: number;
	/** Short, single-line summary shown in the status badge. */
	error?: string;
	/** Full error or crawl log, when one is available. */
	log?: string;
}

export type RefreshPhase =
	| "crawl"
	| "prune"
	| "airbnb-enrich"
	| "osm-index"
	| "geocode"
	| "rcn"
	| "building-assign"
	| "parcel-assign"
	| "parcel-enrich"
	| "listing-derived"
	| "listing-facts"
	| "scoring"
	| "public-investments"
	| "finwire"
	| "done";

/**
 * The pipeline in execution order. The /sources progress bar measures a run
 * against this list, so the phase set is exhaustive by type: adding a member
 * to `RefreshPhase` without giving it a position here is a compile error.
 */
const PHASE_ORDER: Record<RefreshPhase, number> = {
	crawl: 1,
	prune: 2,
	"public-investments": 3,
	finwire: 4,
	"airbnb-enrich": 5,
	"osm-index": 6,
	geocode: 7,
	rcn: 8,
	"building-assign": 9,
	"parcel-assign": 10,
	"parcel-enrich": 11,
	"listing-derived": 12,
	"listing-facts": 13,
	scoring: 14,
	done: 15,
};

export const REFRESH_PHASES: readonly RefreshPhase[] = Object.entries(
	PHASE_ORDER,
)
	.sort((left, right) => left[1] - right[1])
	.map(([phase]) => phase as RefreshPhase);

/**
 * Rough share of a refresh run each phase takes, used only to draw one
 * meaningful progress bar: counting phases equally left the bar at 4% after
 * the whole crawl had finished, which reads as "nothing happened". The crawl
 * dominates wall-clock time, RCN and the building assignment follow, and the
 * rest are short. These are display weights, never scoring input, and they
 * do not need to be exact: they make the bar move in the right proportion
 * and give the ETA the right order of magnitude.
 */
export const PHASE_WEIGHTS: Record<RefreshPhase, number> = {
	crawl: 0.44,
	prune: 0.01,
	"public-investments": 0.02,
	finwire: 0.02,
	"airbnb-enrich": 0.05,
	"osm-index": 0.02,
	geocode: 0.05,
	rcn: 0.11,
	"building-assign": 0.1,
	"parcel-assign": 0.04,
	"parcel-enrich": 0.04,
	"listing-derived": 0.03,
	"listing-facts": 0.04,
	scoring: 0.03,
	done: 0,
};

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
