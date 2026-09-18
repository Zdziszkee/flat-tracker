/**
 * RCN coverage audit: what the transactions table actually holds.
 *
 *   bunx tsx scripts/rcn-audit.ts [--all]
 *
 * Default: coverage of the małopolska powiaty (the map's scope).
 * `--all`: every powiat present, biggest first — the view that matters
 * after a national drain. `--row=<teryt>` inspects one powiat in detail.
 */

import Database from "better-sqlite3";

const db = new Database("dev.db", { readonly: true, timeout: 30_000 });

const arg = (name: string): string | undefined =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const teryt = arg("row");
const showAll = process.argv.includes("--all");

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
