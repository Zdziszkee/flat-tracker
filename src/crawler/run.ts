import "dotenv/config";
import { parseArgs } from "node:util";

import { Effect } from "effect";

import { pruneOldListings } from "./db-sink.ts";
import { runCrawl } from "./pipeline.ts";
import { getAdapter } from "./sites/index.ts";
import type { SiteAdapter } from "./types.ts";

const HELP = [
	"Flat Tracker crawler",
	"",
	"Usage: npm run crawl -- --site <id> [--save-db] [--since-days N] [--retry]",
	"",
	"Sites:",
	"  otodom - Otodom Krakow flats (list + detail pages for coordinates)",
	"  olx    - OLX Krakow flats (coordinates included in list view)",
	"  quotes - Quotes to Scrape (JS-rendered, Playwright demo)",
	"  books  - Books to Scrape (static HTML, Cheerio demo)",
	"",
	"Options:",
	"  --save-db      upsert listings into SQLite",
	"  --since-days N only crawl postings from the last N days (default 90)",
	"                 and prune older otodom/olx listings afterwards",
	"  --retry        retry the crawl with exponential backoff (scheduled runs)",
].join("\n");

async function main() {
	const { values } = parseArgs({
		options: {
			site: { type: "string" },
			"save-db": { type: "boolean", default: false },
			"since-days": { type: "string", default: "90" },
			retry: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});

	if (values.help || !values.site) {
		console.log(HELP);
		return;
	}

	const sinceDays = Math.max(
		0,
		Number.parseInt(values["since-days"] ?? "90", 10) || 90,
	);
	const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

	const base = getAdapter(values.site);
	// A per-run clone carries the date window; only list-paginating sites
	// (otodom, olx) use it, demos ignore it.
	const adapter: SiteAdapter = { ...base, since: since.toISOString() };

	console.log(
		`Crawling "${adapter.name}" (${adapter.kind})... postings since ${since.toISOString().slice(0, 10)}`,
	);

	const program = runCrawl(adapter, values["save-db"]);
	const report = await Effect.runPromise(program);

	console.log(
		`Done in ${report.elapsedSeconds.toFixed(1)}s: ${report.pages} pages, ${report.listings} listings`,
	);
	if (values["save-db"]) {
		console.log(
			`DB diff: ${report.newListings} new, ${report.updatedListings} updated`,
		);
		if (sinceDays > 0 && (adapter.id === "otodom" || adapter.id === "olx")) {
			const pruned = await pruneOldListings(since);
			console.log(
				`Pruned ${pruned} otodom/olx listings older than ${since.toISOString().slice(0, 10)}`,
			);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
