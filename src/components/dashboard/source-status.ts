/**
 * Client-side shapes and formatting for `/api/crawl-status`, plus the tone
 * rules the /sources table shares between the badge and the row.
 */

export interface LastRun {
	startedAt: string | null;
	finishedAt: string | null;
	pages: number | null;
	newCount: number | null;
	updatedCount: number | null;
	error: string | null;
}

export interface LiveState {
	source: string;
	state: "pending" | "running" | "ok" | "failed";
	pages?: number;
	newCount?: number;
	updatedCount?: number;
	error?: string;
	log?: string;
}

export interface SourceStatus {
	id: string;
	name: string;
	kind:
		| "portal"
		| "rcn"
		| "geocode"
		| "airbnb-calendar"
		| "public-investments"
		| "price-index"
		| "scoring";
	lastRun: LastRun | null;
	live: LiveState | null;
}

export interface CrawlStatusResponse {
	running: boolean;
	progress: {
		runId: string;
		status: string;
		startedAt: string;
		finishedAt: string | null;
		phase: string;
	} | null;
	sources: SourceStatus[];
}

/** Older than this and a source's last successful run counts as stale. */
const STALE_MS = 24 * 60 * 60 * 1000;

export function relativeTime(iso: string | null | undefined): string {
	if (!iso) return "never";
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 0) return "just now";
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

export function duration(
	startedAt: string | null | undefined,
	finishedAt: string | null | undefined,
): string {
	if (!startedAt || !finishedAt) return "";
	const s =
		(new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000;
	if (s < 0) return "";
	if (s < 60) return `${s.toFixed(0)}s`;
	return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

export type StatusTone = "running" | "ok" | "error" | "idle";

export function statusTone(s: SourceStatus): StatusTone {
	if (s.live) {
		switch (s.live.state) {
			case "running":
				return "running";
			case "failed":
				return "error";
			case "ok":
				return "ok";
			default:
				return "idle";
		}
	}
	const last = s.lastRun;
	if (!last) return "idle";
	if (last.error) return "error";
	if (
		last.finishedAt &&
		Date.now() - new Date(last.finishedAt).getTime() > STALE_MS
	) {
		return "error";
	}
	return "ok";
}

export function statusLabel(s: SourceStatus): string {
	if (s.live) {
		switch (s.live.state) {
			case "running":
				return "crawling…";
			case "failed":
				return "failed";
			case "ok":
				return "just updated";
			case "pending":
				return "queued";
		}
	}
	const last = s.lastRun;
	if (!last) return "never run";
	if (last.error) return "last run failed";
	if (
		last.finishedAt &&
		Date.now() - new Date(last.finishedAt).getTime() > STALE_MS
	) {
		return "stale";
	}
	return "ok";
}

/** "Result" column copy; shaped per source kind. */
export function metrics(s: SourceStatus): string {
	if (s.live?.state === "running") return "crawling…";
	if (s.live?.state === "pending") return "queued";
	const run = s.lastRun;
	if (!run) return "—";
	const n = run.newCount ?? 0;
	const u = run.updatedCount ?? 0;
	const p = run.pages ?? 0;
	switch (s.kind) {
		case "rcn":
			return `${n} new transactions`;
		case "geocode":
			return `${n} geocoded`;
		case "airbnb-calendar":
			return `${n} listings · ${u} monthly rows`;
		case "public-investments":
			return `${n} new · ${u} updated projects`;
		case "price-index":
			return `${n} index rows`;
		case "scoring":
			return `${u} scored · ${n} alerts`;
		default:
			return `${p} pages · ${n} new · ${u} updated`;
	}
}
