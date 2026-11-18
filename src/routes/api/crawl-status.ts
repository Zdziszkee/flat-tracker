import { statSync } from "node:fs";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, eq, isNull, max, or, sql } from "drizzle-orm";
import {
	getProgress,
	isRunning,
	PHASE_WEIGHTS,
	REFRESH_PHASES,
	type RefreshProgress,
	type SourceProgress,
} from "#/crawler/progress";
import { remoteRefreshRunning } from "#/crawler/refresh-lock";
import {
	type SourceDescriptor,
	sourceDescriptors,
} from "#/crawler/source-status";
import { db } from "#/db/index";
import { crawlRuns } from "#/db/schema";

/**
 * Per-source freshness + live progress, consumed by the /sources page.
 *
 * "Last refreshed" comes from `crawl_runs` (durable, per-source). Live
 * progress (pending/running/ok/failed while a refresh is underway) comes
 * from the in-memory registry in `src/crawler/progress.ts`.
 *
 * Each row also carries the registry's `group` (which /sources section it
 * belongs to) and `static` flag (a reference layer that ships with the app
 * and is never crawled, so it can never go stale). The response's
 * `lastRefreshedAt` is the newest successful finish across every non-static
 * source.
 */

interface LastRun {
	startedAt: string | null;
	finishedAt: string | null;
	pages: number | null;
	newCount: number | null;
	updatedCount: number | null;
	error: string | null;
	errorDetail: string | null;
}

/** Dataset bundled at build time: listed, but never crawled, so never stale. */
function isStaticLayer(descriptor: SourceDescriptor): boolean {
	return descriptor.static === true;
}

/**
 * Last refresh of a layer built by a manual job instead of the hourly
 * crawl (`assign-buildings`, `build:osm-roads`, `build:dem`). Those write a
 * state file (or a tile directory) whose mtime is the only durable trace,
 * so /sources can show real freshness instead of "never".
 */
function layerFileFreshness(descriptor: SourceDescriptor): Date | null {
	const path = descriptor.freshnessFile;
	if (!path) return null;
	try {
		return statSync(path).mtime;
	} catch {
		return null;
	}
}

/**
 * Live source state. `error` stays the compact badge text; `log` is the
 * optional full log the /sources panel can expand.
 */
function toLiveState(
	source: SourceProgress | undefined,
): SourceProgress | null {
	if (!source) return null;
	return {
		source: source.source,
		state: source.state,
		startedAt: source.startedAt,
		finishedAt: source.finishedAt,
		pages: source.pages,
		newCount: source.newCount,
		updatedCount: source.updatedCount,
		error: source.error,
		log: source.log,
	};
}

const toIso = (value: Date | null | undefined): string | null =>
	value ? value.toISOString() : null;

/** Live numbers the /sources progress card renders. */
interface RunProgress {
	runId: string;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	phase: string;
	/** 1-based position of the current phase in `REFRESH_PHASES`. */
	phaseIndex: number;
	phasesTotal: number;
	/** Work inside the current phase, when the phase reports it. */
	phaseDone: number | null;
	phaseTotal: number | null;
	elapsedMs: number;
	/** Offers stored by the crawl phase of this run. */
	offersNew: number;
	offersUpdated: number;
	offersTotal: number;
	/** Offers per minute over the phase that produced them. */
	offersPerMinute: number | null;
	/** 0-1 estimate from the phase position; null when not measurable. */
	fraction: number | null;
	etaMs: number | null;
	/** Sources being worked on right now. */
	current: string[];
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Summarise a live run for the progress card.
 *
 * The bar is measured in phases, not offers: a crawl has no known offer
 * total, while the phases that do report a total (facts, scoring) are a
 * single row each. Inside the crawl phase the fraction is the share of
 * portals that have settled, so the bar moves as each portal finishes.
 */
function summariseProgress(
	progress: RefreshProgress,
	portalIds: ReadonlySet<string>,
	nowMs: number,
): RunProgress {
	const startedMs = Date.parse(progress.startedAt);
	const elapsedMs = Number.isFinite(startedMs)
		? Math.max(0, nowMs - startedMs)
		: 0;
	const phasesTotal = REFRESH_PHASES.filter((phase) => phase !== "done").length;
	const phaseIndex = Math.max(1, REFRESH_PHASES.indexOf(progress.phase) + 1);
	const settled = (row: SourceProgress) =>
		row.state === "ok" || row.state === "failed";

	let offersNew = 0;
	let offersUpdated = 0;
	for (const row of progress.sources) {
		offersNew += row.newCount ?? 0;
		offersUpdated += row.updatedCount ?? 0;
	}

	let fraction: number | null = null;
	let phaseDone: number | null = null;
	let phaseTotal: number | null = null;
	if (progress.phase === "crawl") {
		const portals = progress.sources.filter((row) => portalIds.has(row.source));
		phaseTotal = portals.length;
		phaseDone = portals.filter(settled).length;
		fraction = portals.length > 0 ? phaseDone / portals.length : null;
	} else {
		const row = progress.sources.find((entry) => entry.state === "running");
		if (row?.done != null && row.total != null && row.total > 0) {
			phaseDone = row.done;
			phaseTotal = row.total;
			fraction = row.done / row.total;
		} else if (row && settled(row)) {
			phaseDone = 1;
			phaseTotal = 1;
			fraction = 1;
		}
	}
	// Weighted, not phase-counted: the crawl is ~45% of a run and must move
	// the bar accordingly, otherwise finishing every portal shows 4%.
	let completedWeight = 0;
	for (const phase of REFRESH_PHASES) {
		if (phase === progress.phase) break;
		completedWeight += PHASE_WEIGHTS[phase];
	}
	const currentWeight = PHASE_WEIGHTS[progress.phase] ?? 0;
	const overall =
		fraction == null
			? completedWeight
			: clamp01(completedWeight + currentWeight * fraction);
	const etaMs =
		overall != null && overall > 0.03
			? Math.round((elapsedMs * (1 - overall)) / overall)
			: null;

	return {
		runId: progress.runId,
		status: progress.status,
		startedAt: progress.startedAt,
		finishedAt: progress.finishedAt ?? null,
		phase: progress.phase,
		phaseIndex,
		phasesTotal,
		phaseDone,
		phaseTotal,
		elapsedMs,
		offersNew,
		offersUpdated,
		offersTotal: offersNew + offersUpdated,
		offersPerMinute:
			elapsedMs > 5_000
				? Math.round(((offersNew + offersUpdated) / elapsedMs) * 60_000)
				: null,
		fraction: overall,
		etaMs,
		current: progress.sources
			.filter((row) => row.state === "running")
			.map((row) => row.source),
	};
}

export const Route = createFileRoute("/api/crawl-status")({
	server: {
		handlers: {
			GET: async () => {
				// Latest crawl run per source, via max(id) (id is autoincrement).
				const latest = db
					.select({
						source: crawlRuns.source,
						maxId: sql<number>`max(${crawlRuns.id})`.as("max_id"),
					})
					.from(crawlRuns)
					.groupBy(crawlRuns.source)
					.as("latest");

				const rows = await db
					.select({
						source: crawlRuns.source,
						startedAt: crawlRuns.startedAt,
						finishedAt: crawlRuns.finishedAt,
						pages: crawlRuns.pages,
						newCount: crawlRuns.newCount,
						updatedCount: crawlRuns.updatedCount,
						error: crawlRuns.error,
						errorDetail: crawlRuns.errorDetail,
					})
					.from(crawlRuns)
					.innerJoin(
						latest,
						and(
							eq(crawlRuns.source, latest.source),
							eq(crawlRuns.id, latest.maxId),
						),
					);

				const lastBySource = new Map<string, LastRun>();
				for (const r of rows) {
					lastBySource.set(r.source, {
						startedAt: toIso(r.startedAt),
						finishedAt: toIso(r.finishedAt),
						pages: r.pages,
						newCount: r.newCount,
						updatedCount: r.updatedCount,
						error: r.error,
						errorDetail: r.errorDetail,
					});
				}

				// Newest successful finish per source. A run is successful when it
				// recorded no error (an empty string counts as no error). The
				// column is a drizzle timestamp, so `max` maps back to a Date.
				const lastSuccessRows = await db
					.select({
						source: crawlRuns.source,
						lastSuccessAt: max(crawlRuns.finishedAt),
					})
					.from(crawlRuns)
					.where(or(isNull(crawlRuns.error), eq(crawlRuns.error, "")))
					.groupBy(crawlRuns.source);

				const lastSuccessBySource = new Map<string, Date>();
				for (const r of lastSuccessRows) {
					if (r.lastSuccessAt) {
						lastSuccessBySource.set(r.source, r.lastSuccessAt);
					}
				}

				const descriptors = sourceDescriptors.map((descriptor) => ({
					descriptor,
					group: descriptor.group,
					staticLayer: isStaticLayer(descriptor),
					fileFreshness: layerFileFreshness(descriptor),
				}));

				// Overall freshness ignores static reference layers: they are
				// shipped with the app, never crawled, so they cannot age.
				let lastRefreshed: Date | null = null;
				for (const { descriptor, staticLayer, fileFreshness } of descriptors) {
					if (staticLayer) continue;
					const success =
						lastSuccessBySource.get(descriptor.id) ?? fileFreshness;
					if (success && (!lastRefreshed || success > lastRefreshed)) {
						lastRefreshed = success;
					}
				}

				// The dev-boot crawl runs in a child process, so fall back to
				// the shared record it publishes every second.
				const remote = remoteRefreshRunning();
				const progress = getProgress() ?? remote;
				const portalIds = new Set(
					descriptors
						.filter(
							({ group, staticLayer }) => group === "portal" && !staticLayer,
						)
						.map(({ descriptor }) => descriptor.id),
				);

				return json({
					running: isRunning() || remote != null,
					lastRefreshedAt: toIso(lastRefreshed),
					progress: progress
						? summariseProgress(progress, portalIds, Date.now())
						: null,
					sources: descriptors.map(
						({ descriptor, group, staticLayer, fileFreshness }) => ({
							id: descriptor.id,
							name: descriptor.name,
							kind: descriptor.kind,
							group,
							static: staticLayer,
							lastRun: lastBySource.get(descriptor.id) ?? null,
							// A script-built layer has no crawl run; its state file is
							// the freshness signal.
							lastSuccessAt: toIso(
								lastSuccessBySource.get(descriptor.id) ?? fileFreshness,
							),
							live: toLiveState(
								progress?.sources.find((s) => s.source === descriptor.id),
							),
						}),
					),
				});
			},
		},
	},
});
