/**
 * Extract listing facts from the title and description with the model.
 *
 * Manual drain: the hourly refresh runs a bounded slice of the same function
 * (phase `listing-facts`), this script is for the full backlog and for
 * re-reading everything after a prompt change.
 *
 *   bun run extract:facts                  # 2 000 offers, newest first
 *   bun run extract:facts -- --limit 0     # everything still missing
 *   bun run extract:facts -- --kind plot --force
 *   bun run extract:facts -- --dry-run     # call the model, store nothing
 *
 * Reads OPENCODE_GO_API_KEY from the environment (`.env.local` is loaded by
 * the package script), so a fresh clone without a key fails with one clear
 * line instead of a stack trace.
 */
import { llmConfigured, llmModel } from "#/lib/llm/client.ts";
import {
	countListingsMissingFacts,
	extractListingFacts,
} from "#/lib/llm/extract.ts";
import { runAlertScoring } from "#/lib/scoring/run.ts";

interface Args {
	limit: number;
	concurrency: number;
	force: boolean;
	dryRun: boolean;
	kind: "apartment" | "house" | "plot" | null;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		limit: 2000,
		concurrency: 6,
		force: false,
		dryRun: false,
		kind: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--force") args.force = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--limit") {
			// 0 means "no cap": the backlog is drained in one run.
			const value = Number(next);
			args.limit = Number.isFinite(value) && value >= 0 ? value : args.limit;
			i++;
		} else if (arg === "--concurrency") {
			const value = Number(next);
			if (Number.isFinite(value) && value > 0) args.concurrency = value;
			i++;
		} else if (arg === "--kind") {
			if (next === "apartment" || next === "house" || next === "plot") {
				args.kind = next;
			}
			i++;
		}
	}
	return args;
}

async function main(): Promise<void> {
	if (!llmConfigured()) {
		console.error(
			"OPENCODE_GO_API_KEY is not set. Add it to .env.local (same key as opencode/jcode) and re-run.",
		);
		process.exitCode = 1;
		return;
	}
	const args = parseArgs(process.argv.slice(2));
	const missing = await countListingsMissingFacts();
	console.log(
		`model=${llmModel()} missing=${missing} limit=${args.limit || "all"} concurrency=${args.concurrency}${args.force ? " force" : ""}${args.dryRun ? " dry-run" : ""}`,
	);
	const summary = await extractListingFacts({
		limit: args.limit === 0 ? missing : args.limit,
		concurrency: args.concurrency,
		force: args.force,
		dryRun: args.dryRun,
		propertyKind: args.kind,
		onProgress: ({ done, total, stored, errors }) => {
			if (done % 100 !== 0 && done !== total) return;
			console.log(`  ${done}/${total} sent, stored=${stored} errors=${errors}`);
		},
	});
	console.log(
		`scanned=${summary.scanned} sent=${summary.sent} stored=${summary.stored} promoted=${summary.promoted} skipped=${summary.skipped} errors=${summary.errors} in ${Math.round(summary.durationMs / 1000)}s`,
	);
	for (const error of summary.firstErrors) console.error(`  ! ${error}`);
	if (!args.dryRun) {
		// The offers whose facts just landed were scored before the facts
		// existed (or never scored at all). Re-score them now, exactly like
		// the refresh's listing-facts phase does, so a drain flips the gates
		// it can flip instead of waiting for the next full re-score.
		if (summary.gateIds.length > 0) {
			console.log(`re-scoring ${summary.gateIds.length} offers with new facts...`);
			const rescored = await runAlertScoring({
				all: true,
				listingIds: summary.gateIds,
			});
			console.log(
				`re-scored ${rescored.scored} offers, ${rescored.eligible} eligible, ` +
					`${rescored.alerts} alerts, ${rescored.errors} errors`,
			);
		}
		const remaining = await countListingsMissingFacts();
		console.log(`remaining=${remaining}`);
	}
}

void main().catch((error: unknown) => {
	console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
	if (error instanceof Error && error.stack) console.error(error.stack);
	process.exitCode = 1;
});
