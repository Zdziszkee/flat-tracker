/**
 * Which facts each source actually delivers, measured on the stored rows.
 *
 * The adapters parse what the app models, and the LLM reads the prose, but the
 * question "are we missing a field this portal publishes?" needs numbers per
 * source: how many rows carry a building type, a heating source, a build year,
 * a plot type, model facts, and what the raw `features` blobs contain.
 *
 *   bun run audit:sources              # markdown table on stdout
 *   bun run audit:sources --write      # also write docs/source-field-coverage.md
 */
import { writeFileSync } from "node:fs";

import { db } from "#/db/index";

interface Row {
	source: string;
	rows: number;
	visible: number;
	buildingType: number;
	heating: number;
	buildYear: number;
	plotType: number;
	area: number;
	facts: number;
	scored: number;
}

const COLUMNS: Array<{ key: keyof Row; label: string }> = [
	{ key: "rows", label: "ofert" },
	{ key: "visible", label: "widocznych" },
	{ key: "area", label: "m²" },
	{ key: "buildingType", label: "budynek" },
	{ key: "heating", label: "ogrzewanie" },
	{ key: "buildYear", label: "rok budowy" },
	{ key: "plotType", label: "typ działki" },
	{ key: "facts", label: "fakty LLM" },
	{ key: "scored", label: "ocenione" },
];

const rows = (await db.$client
	.prepare(
		`select l.source as source,
			count(*) as rows,
			sum(case when l.is_visible = 1 then 1 else 0 end) as visible,
			sum(case when l.building_type is not null then 1 else 0 end) as buildingType,
			sum(case when l.heating_type is not null then 1 else 0 end) as heating,
			sum(case when l.build_year is not null then 1 else 0 end) as buildYear,
			sum(case when l.plot_type is not null then 1 else 0 end) as plotType,
			sum(case when l.areaM2 is not null then 1 else 0 end) as area,
			sum(case when f.listing_id is not null then 1 else 0 end) as facts,
			sum(case when s.listing_id is not null then 1 else 0 end) as scored
		from listings l
		left join listing_facts f on f.listing_id = l.id
		left join (select distinct listing_id from listing_scores) s on s.listing_id = l.id
		group by l.source
		order by rows desc`,
	)
	.all()) as Row[];

const pct = (value: number, total: number) =>
	total === 0 ? "0" : `${Math.round((value / total) * 100)}%`;

const header = `| źródło | ${COLUMNS.map((column) => column.label).join(" | ")} |`;
const divider = `|---|${COLUMNS.map(() => "---:").join("|")}|`;
const body = rows.map(
	(row) =>
		`| ${row.source} | ${COLUMNS.map((column) =>
			column.key === "rows" || column.key === "visible"
				? String(row[column.key])
				: pct(Number(row[column.key]), row.rows),
		).join(" | ")} |`,
);

const table = [
	"# Field coverage per source",
	"",
	`Measured ${new Date().toISOString().slice(0, 10)} over every stored listing (percentage of the source's rows).`,
	"",
	header,
	divider,
	...body,
	"",
].join("\n");

process.stdout.write(table);

if (process.argv.includes("--write")) {
	writeFileSync("docs/source-field-coverage.md", table);
	console.log("\nwrote docs/source-field-coverage.md");
}
