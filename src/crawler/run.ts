import "dotenv/config";
import { parseArgs } from "node:util";

import { Effect } from "effect";

import { runCrawl } from "./pipeline.ts";
import { getAdapter } from "./sites/index.ts";

const HELP = [
	"Flat Tracker crawler",
	"",
	"Usage: npm run crawl -- --site <id> [--save-db] [--retry]",
	"",
	"Sites:",
	"  otodom - Otodom Krakow flats (list + detail pages for coordinates)",
	"  olx    - OLX Krakow flats (coordinates included in list view)",
	"  quotes - Quotes to Scrape (JS-rendered, Playwright demo)",
	"  books  - Books to Scrape (static HTML, Cheerio demo)",
	"",
	"Options:",
	"  --save-db  upsert listings into SQLite",
	"  --retry    retry the crawl with exponential backoff (scheduled runs)",
].join("\n");

async function main() {
	const { values } = parseArgs({
		options: {
			site: { type: "string" },
			"save-db": { type: "boolean", default: false },
			retry: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});

	if (values.help || !values.site) {
		console.log(HELP);
		return;
	}

	const adapter = getAdapter(values.site);
	console.log(`Crawling "${adapter.name}" (${adapter.kind})...`);

	const program = runCrawl(adapter, values["save-db"]);
	const report = await Effect.runPromise(program);

	console.log(
		`Done in ${report.elapsedSeconds.toFixed(1)}s: ${report.pages} pages, ${report.listings} listings`,
	);
	if (values["save-db"]) {
		console.log(`Upserted ${report.inserted} rows in SQLite`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
