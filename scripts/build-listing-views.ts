/**
 * Render the per-kind SQL views the listings table exposes, and (with
 * `--write`) write them as the next drizzle migration.
 *
 * `listings` is one wide row, but a plot has no heating, a flat has no plot
 * type and a short-term rental has no wiadomo-czynsz. `src/lib/listing-schema.ts`
 * is the single map of which column belongs to which kind; this script turns
 * that map into real database views, so `select * from listing_flats` returns
 * the flat schema and nothing else.
 *
 *   bun run build:listing-views          # print the SQL
 *   bun run build:listing-views --write  # write drizzle/<next>_listing_kind_views.sql
 *
 * The views are generated from the drizzle table metadata (the real column
 * names: the table mixes `pricePerM2` and `street_number`), so a renamed or
 * added column cannot leave the views stale. `bun run validate:listing-schema`
 * compares the stored views with the map.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getTableColumns } from "drizzle-orm";

import { listings } from "#/db/schema";
import type { PropertyKind } from "#/lib/property-kind";
import { viewColumns } from "#/lib/listing-schema";

/** drizzle splits one migration file on this marker. */
const BREAKPOINT = "--> statement-breakpoint";

const VIEWS: Array<{ view: string; kind: PropertyKind }> = [
	{ view: "listing_flats", kind: "apartment" },
	{ view: "listing_houses", kind: "house" },
	{ view: "listing_plots", kind: "plot" },
];

const columns = getTableColumns(listings) as Record<
	string,
	{ name: string }
>;

export function viewSql(): string {
	const statements: string[] = [];
	for (const { view, kind } of VIEWS) {
		const names = viewColumns(kind).map((key) => {
			const column = columns[key];
			if (!column) throw new Error(`unknown listing column: ${key}`);
			return `"${column.name}"`;
		});
		const kindColumn = columns.propertyKind.name;
		statements.push(`drop view if exists ${view};`);
		statements.push(
			[
				`create view ${view} as`,
				`\tselect ${names.join(", ")}`,
				`\tfrom listings`,
				`\twhere ${kindColumn} = '${kind}';`,
			].join("\n"),
		);
	}
	// drizzle's better-sqlite3 migrator prepares one statement at a time, so
	// every statement is separated by its breakpoint marker.
	return `${statements.join(`\n${BREAKPOINT}\n`)}\n`;
}

function nextMigrationName(): string {
	const dir = "drizzle";
	const files = readdirSync(dir).filter((name) => /^\d{4}_.+\.sql$/u.test(name));
	const last = files.sort().at(-1) ?? "0000_none.sql";
	const index = Number(last.slice(0, 4)) + 1;
	return `${String(index).padStart(4, "0")}_listing_kind_views.sql`;
}

function appendJournal(tag: string): void {
	const path = join("drizzle", "meta", "_journal.json");
	const journal = JSON.parse(readFileSync(path, "utf8")) as {
		entries: Array<{ idx: number; tag: string; when: number }>;
	};
	if (journal.entries.some((entry) => entry.tag === tag)) return;
	const index = (journal.entries.at(-1)?.idx ?? 0) + 1;
	journal.entries.push({ idx: index, tag, when: Date.now(), version: "6", breakpoints: true } as never);
	writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`);
}

const sql = viewSql();
if (process.argv.includes("--write")) {
	const name = nextMigrationName();
	const tag = name.replace(/\.sql$/u, "");
	writeFileSync(join("drizzle", name), sql);
	appendJournal(tag);
	console.log(`wrote drizzle/${name} (${sql.split("\n").length} lines)`);
} else {
	process.stdout.write(sql);
}
