/**
 * CLI entry for an out-of-process refresh.
 *
 * Spawned by `spawnRefreshProcess()` (the manual "Refresh now" button and the
 * scheduled task) and by `server/boot-refresh.ts` (dev start). Never imported
 * by the HTTP server graph: the whole point is that the crawler module graph
 * (Crawlee, Playwright, better-sqlite3, Effect) is loaded here, not there.
 *
 *   node --import tsx server/refresh-child.ts [--diff-only] [--since-days=N]
 *     [--full-crawl] [--no-rcn] [--label=NAME]
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SINCE_DAYS, DEV_SINCE_DAYS } from "#/crawler/refresh-options";
import { runRefreshChild } from "#/crawler/refresh-runner";

function flag(argv: string[], name: string): boolean {
	return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function numberArg(argv: string[], name: string, fallback: number): number {
	const hit = argv.find((arg) => arg.startsWith(`${name}=`));
	if (!hit) return fallback;
	const value = Number(hit.slice(name.length + 1));
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function textArg(argv: string[], name: string, fallback: string): string {
	const hit = argv.find((arg) => arg.startsWith(`${name}=`));
	return hit ? hit.slice(name.length + 1) : fallback;
}

const argv = process.argv.slice(2);
const diffOnly = flag(argv, "--diff-only");

const isEntryPoint =
	process.argv[1] != null &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
	process.exitCode = await runRefreshChild({
		label: textArg(argv, "--label", "child"),
		diffOnly,
		sinceDays: numberArg(
			argv,
			"--since-days",
			diffOnly ? DEV_SINCE_DAYS : DEFAULT_SINCE_DAYS,
		),
		firstPageOnly: !flag(argv, "--full-crawl"),
		includeRcn: !flag(argv, "--no-rcn"),
	});
}
