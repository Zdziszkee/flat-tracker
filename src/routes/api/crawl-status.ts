import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, eq, sql } from "drizzle-orm";
import { getProgress, isRunning } from "#/crawler/progress";
import { sourceDescriptors } from "#/crawler/source-status";
import { db } from "#/db/index";
import { crawlRuns } from "#/db/schema";

/**
 * Per-source freshness + live progress, consumed by the /sources page.
 *
 * "Last refreshed" comes from `crawl_runs` (durable, per-source). Live
 * progress (pending/running/ok/failed while a refresh is underway) comes
 * from the in-memory registry in `src/crawler/progress.ts`.
 */

interface LastRun {
	startedAt: string | null;
	finishedAt: string | null;
	pages: number | null;
	newCount: number | null;
	updatedCount: number | null;
	error: string | null;
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
						startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
						finishedAt: r.finishedAt
							? new Date(r.finishedAt).toISOString()
							: null,
						pages: r.pages,
						newCount: r.newCount,
						updatedCount: r.updatedCount,
						error: r.error,
					});
				}

				const progress = getProgress();

				return json({
					running: isRunning(),
					progress: progress
						? {
								runId: progress.runId,
								status: progress.status,
								startedAt: progress.startedAt,
								finishedAt: progress.finishedAt ?? null,
								phase: progress.phase,
							}
						: null,
					sources: sourceDescriptors.map((d) => ({
						id: d.id,
						name: d.name,
						kind: d.kind,
						lastRun: lastBySource.get(d.id) ?? null,
						live: progress?.sources.find((s) => s.source === d.id) ?? null,
					})),
				});
			},
		},
	},
});
