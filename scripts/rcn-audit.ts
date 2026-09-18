/**
 * RCN coverage audit: what the transactions table actually holds.
 *
 *   bunx tsx scripts/rcn-audit.ts [--all]
 *
 * Default: coverage of the małopolska powiaty (the map's scope).
 * `--all`: every powiat present, biggest first — the view that matters
 * after a national drain. `--row=<teryt>` inspects one powiat in detail.
 * `--gaps` compares the published catalogue and the drain state file
 * against the table: which packages were never imported, and which are
 * claimed imported but hold no rows.
 */

import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const db = new Database("dev.db", { readonly: true, timeout: 30_000 });

const arg = (name: string): string | undefined =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const teryt = arg("row");
const showAll = process.argv.includes("--all");
const showGaps = process.argv.includes("--gaps");

type Index = Record<string, { bytes: number }>;

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

if (showGaps) {
	const catalogue = readJson<Index>("data/rcn/gugik/teryt-index.json");
	const state = readJson<{ checkedAt?: Record<string, string> }>(
		"data/rcn/gugik/state.json",
	);
	if (!catalogue) {
		console.error("no catalogue; run `bun run discover:rcn-powiats`");
		process.exit(1);
	}
	const published = Object.keys(catalogue).sort();
	const stamped = state?.checkedAt ?? {};
	const loaded = new Map<string, number>();
	for (const r of db
		.prepare(
			`select substr(transactionId, 1, instr(transactionId, '-G/') - 1) t, count(*) n
			 from transactions where transactionId like '%-G/%' group by 1`,
		)
		.all() as Array<{ t: string; n: number }>) {
		loaded.set(r.t, r.n);
	}
	// 1261 is deliberately taken from the city GML instead, not a gap.
	const skipped = new Set(["1261"]);
	const missing = published.filter((t) => !skipped.has(t) && !loaded.has(t));
	const empty = published.filter((t) => loaded.get(t) === 0);
	const neverStamped = published.filter((t) => !skipped.has(t) && !stamped[t]);
	console.log(`published packages : ${published.length}`);
	console.log(`loaded into table  : ${loaded.size} (incl. 1261: ${loaded.has("1261")})`);
	console.log(`not loaded yet     : ${missing.length}${missing.length ? ` -> ${missing.join(", ")}` : ""}`);
	console.log(`loaded but empty   : ${empty.length}${empty.length ? ` -> ${empty.join(", ")}` : ""}`);
	console.log(`not in state.json  : ${neverStamped.length}`);
	const bytes = published.reduce(
		(s, t) => s + (loaded.has(t) ? catalogue[t]?.bytes ?? 0 : 0),
		0,
	);
	console.log(
		`downloaded so far  : ${(bytes / 1e9).toFixed(2)} GB of ` +
			`${(published.reduce((s, t) => s + (catalogue[t]?.bytes ?? 0), 0) / 1e9).toFixed(2)} GB`,
	);
	process.exit(missing.length === 0 ? 0 : 1);
}

if (teryt) {
	const rows = db
		.prepare(
			`select
         count(*) n,
         count(lat) with_geo,
         round(min(lat), 3) minLat, round(max(lat), 3) maxLat,
         round(min(lng), 3) minLng, round(max(lng), 3) maxLng,
         round(avg(pricePerM2)) avgPpm2,
         date(min(date), 'unixepoch') firstDate,
         date(max(date), 'unixepoch') lastDate
       from transactions where transactionId like ?`,
		)
		.get(`${teryt}-G/%`);
	console.log(JSON.stringify(rows, null, 1));
	process.exit(0);
}

const totals = db
	.prepare(
		`select count(*) n,
           sum(transactionId not like '%-G/%') as krakow_gml,
           sum(transactionId like '%-G/%') as gugik,
           count(lat) withGeo
     from transactions`,
	)
	.get() as Record<string, number>;
console.log("total rows:", totals.n);
console.log("  Kraków GML (import-rcn):", totals.krakow_gml);
console.log("  GUGiK per-powiat       :", totals.gugik);
console.log("  with coordinates       :", totals.withGeo);

const per = db
	.prepare(
		`select substr(transactionId, 1, instr(transactionId, '-G/') - 1) teryt,
            count(*) n
     from transactions
     where transactionId like '%-G/%'
     group by 1
     order by ${showAll ? "n desc" : "1"}`,
	)
	.all() as Array<{ teryt: string; n: number }>;
console.log(`\npowiaty loaded: ${per.length}`);
const list = showAll ? per.slice(0, 20) : per.filter((p) => p.teryt.startsWith("12"));
for (const p of list) console.log(`  ${p.teryt}: ${p.n}`);
