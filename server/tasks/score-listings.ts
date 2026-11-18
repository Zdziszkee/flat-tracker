import "nitro/types";
import { defineTask } from "nitro/task";

import {
	canSpawnScoreProcess,
	scoreRunning,
	spawnScoreProcess,
} from "#/lib/scoring/process";
import { runAlertScoring, type ScoreRunSummary } from "#/lib/scoring/run";

/**
 * Daily alert scoring task.
 *
 * The crawl and the scoring run are synchronous SQLite/RBush workloads. They
 * run in a child process so the HTTP server stays responsive. A deployment
 * without the TS runner falls back to an in-process run.
 *
 * Manual backfill:
 *   POST /_nitro/tasks/score-listings
 *   payload {"all": true, "limit": 500, "dryRun": true}
 */
interface ScoreTaskResult {
	started: boolean;
	alreadyRunning: boolean;
	pid?: number;
	summary?: ScoreRunSummary;
}

export default defineTask({
	meta: {
		name: "score-listings",
		description:
			"Score sale offers and create the daily top 5% in-app alerts",
	},
	run: async ({ payload }): Promise<{ result: ScoreTaskResult }> => {
		const all = payload?.all === true;
		const limit =
			typeof payload?.limit === "number" && payload.limit > 0
				? payload.limit
				: undefined;
		const days =
			typeof payload?.days === "number" && payload.days > 0
				? payload.days
				: undefined;
		const dryRun = payload?.dryRun === true;
		const listingIds = Array.isArray(payload?.listingIds)
			? payload.listingIds.filter(
					(id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0,
				)
			: undefined;

		if (canSpawnScoreProcess()) {
			const running = scoreRunning();
			if (running != null) {
				return { result: { started: false, alreadyRunning: true } };
			}
			const pid = spawnScoreProcess({ all, limit, days, listingIds, dryRun });
			return {
				result: {
					started: pid != null,
					alreadyRunning: pid == null,
					pid,
				},
			};
		}

		const summary = await runAlertScoring({ all, limit, days, listingIds, dryRun });
		console.log(
			`[score fallback] scanned=${summary.scanned} scored=${summary.scored} ` +
				`eligible=${summary.eligible} alerts=${summary.alerts} ` +
				`errors=${summary.errors} in ${summary.durationMs}ms`,
		);
		return { result: { started: true, alreadyRunning: false, summary } };
	},
});
