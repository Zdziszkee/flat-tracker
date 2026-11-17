import { statSync } from "node:fs";
import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, eq, isNull, max, or, sql } from "drizzle-orm";
import {
	getProgress,
	isRunning,
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

				return json({
					running: isRunning() || remote != null,
					lastRefreshedAt: toIso(lastRefreshed),
					progress: progress
						? {
								runId: progress.runId,
								status: progress.status,
								startedAt: progress.startedAt,
								finishedAt: progress.finishedAt ?? null,
								phase: progress.phase,
							}
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
