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
	/** One-line cause for the row. */
	error: string | null;
	/** Full cause chain and stack traces, shown when the row is expanded. */
	errorDetail: string | null;
}

export interface LiveState {
	source: string;
	state: "pending" | "running" | "ok" | "failed";
	pages?: number;
	newCount?: number;
	updatedCount?: number;
	/** Work inside one phase: offers processed out of the candidates. */
	done?: number;
	total?: number;
	error?: string;
	log?: string;
}

/** Section of the /sources table; mirrors `src/crawler/source-status.ts`. */
export type SourceGroup = "portal" | "data" | "processing";

/** Registry kind; `layer` and `enrich` cover the added pipeline descriptors. */
export type SourceKind =
	| "portal"
	| "rcn"
	| "geocode"
	| "airbnb-calendar"
	| "public-investments"
	| "price-index"
	| "scoring"
	| "layer"
	| "enrich";

export interface SourceStatus {
	id: string;
	name: string;
	kind: SourceKind;
	/** Which section of the table the source belongs to. */
	group: SourceGroup;
	/**
	 * Reference layer shipped with the app: never crawled, so it has no run
	 * history and can never be stale.
	 */
	static: boolean;
	lastRun: LastRun | null;
	/** Most recent run that recorded no error. */
	lastSuccessAt: string | null;
	live: LiveState | null;
}

/** Live numbers of the run in flight, computed by `/api/crawl-status`. */
export interface RunProgress {
	runId: string;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	phase: string;
	/** 1-based position of the phase in the pipeline. */
	phaseIndex: number;
	phasesTotal: number;
	phaseDone: number | null;
	phaseTotal: number | null;
	elapsedMs: number;
	offersNew: number;
	offersUpdated: number;
	offersTotal: number;
	offersPerMinute: number | null;
	/** 0-1 estimate of the whole run. */
	fraction: number | null;
	etaMs: number | null;
	current: string[];
}

export interface CrawlStatusResponse {
	running: boolean;
	/** Newest successful run across every non-static source. */
	lastRefreshedAt: string | null;
	progress: RunProgress | null;
	sources: SourceStatus[];
}

/** Polish label for a pipeline phase, in pipeline order. */
const PHASE_LABELS: Record<string, string> = {
	crawl: "Pobieranie portali",
	prune: "Czyszczenie starych ofert",
	"public-investments": "Inwestycje publiczne",
	finwire: "Indeksy cen (finwire)",
	"airbnb-enrich": "Wzbogacanie Airbnb",
	geocode: "Geokodowanie adresów",
	rcn: "Import RCN",
	"building-assign": "Przypisanie do budynków",
	"parcel-assign": "Przypisanie działek",
	"parcel-enrich": "Wzbogacanie działek",
	"listing-derived": "Kolumny pochodne ofert",
	"listing-facts": "Ekstrakcja faktów (LLM)",
	scoring: "Scoring i alerty",
	done: "Zakończone",
};

export function phaseLabel(phase: string): string {
	return PHASE_LABELS[phase] ?? phase;
}

/** "1:07" / "12 min" for a duration in milliseconds. */
export function elapsedLabel(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return `${minutes}:${String(rest).padStart(2, "0")} min`;
	const hours = Math.floor(minutes / 60);
	return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Compact count, Polish grouping: 1 234. */
export function countLabel(value: number): string {
	return value.toLocaleString("pl-PL");
}

/** Older than this and a source's last successful run counts as stale. */
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The one 24 h freshness rule: used by the per-row badges and by the panel's
 * "dane aktualne" / "starsze niż 24 h" note, so both always agree.
 */
export function isStale(iso: string | null | undefined): boolean {
	if (!iso) return false;
	return Date.now() - new Date(iso).getTime() > STALE_MS;
}

/** State note for the overall "last refreshed" indicator. */
export function freshnessLabel(iso: string | null | undefined): string {
	if (!iso) return "brak danych";
	return isStale(iso) ? "starsze niż 24 h" : "dane aktualne";
}

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

/** Absolute date/time for tooltips and accessible descriptions. */
export function absoluteTime(iso: string | null | undefined): string {
	if (!iso) return "brak danych";
	return new Date(iso).toLocaleString("pl-PL", {
		dateStyle: "medium",
		timeStyle: "short",
	});
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
	// Static reference layers carry no run history and never age.
	if (s.static) return "idle";
	const last = s.lastRun;
	if (!last) return "idle";
	if (last.error) return "error";
	if (isStale(last.finishedAt)) {
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
	if (s.static) return "wbudowane";
	const last = s.lastRun;
	if (!last) return "never run";
	if (last.error) return "last run failed";
	if (isStale(last.finishedAt)) {
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
		// Layer and enrichment phases report stored rows, not crawled pages.
		case "layer":
		case "enrich":
			return `${n} new · ${u} updated`;
		default:
			return `${p} pages · ${n} new · ${u} updated`;
	}
}
