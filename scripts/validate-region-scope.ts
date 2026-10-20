/**
 * Validate the tracked-region scope (małopolskie + śląskie) and the three
 * things that can silently break it:
 *
 * 1. `transactions.region` is a generated column, i.e. its CASE expression is
 *    baked into the table. Editing a box in `src/db/region.ts` without a
 *    migration would leave the column computing the OLD boxes while the code
 *    filters with the new predicate — every new row mis-bucketed, no error
 *    anywhere. This compares the stored expression with `REGION_CASE_SQL`.
 * 2. A partial index is only used when the query's predicate matches it, so
 *    the check runs the real aggregation through `explain query plan` and
 *    insists on the regional index instead of a full scan. (A two-rectangle
 *    OR predicate fails this and was rejected for exactly that reason, see
 *    region.ts.)
 * 3. The regions are listed twice on purpose — `TRACKED_REGIONS` for SQL and
 *    crawler geometry, `REGIONS` in `src/crawler/regions.ts` for the portal
 *    slugs and TERYT codes — and the OSM index has its own list of Geofabrik
 *    extracts. All three must agree, or one voivodeship quietly disappears
 *    from one layer.
 *
 * Run: bun run validate:regions
 */
import { sql } from "drizzle-orm";

import { db, sqlite } from "../src/db/index";
import {
	inRegion,
	inTrackedRegions,
	REGION_CASE_SQL,
	REGION_PREDICATE_SQL,
	regionOf,
	regionPredicate,
	TRACKED_REGIONS,
	TRACKED_REGION_IDS,
	type TrackedRegion,
} from "../src/db/region";
import { OSM_REGIONS } from "../src/crawler/osm-index";
import { REGIONS } from "../src/crawler/regions";

let failures = 0;
const check = (ok: boolean, label: string, extra = ""): void => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
	if (!ok) failures++;
};

/** Whitespace- and case-insensitive form, for comparing SQL text. */
const norm = (text: string): string =>
	text.toLowerCase().replace(/\s+/g, "").replace(/`|"/g, "");

/** `lat between ... and lng between ...` for one box, built from the code. */
function boxText(id: TrackedRegion): string {
	const box = TRACKED_REGIONS[id];
	return (
		`lat between ${box.minLat} and ${box.maxLat} and ` +
		`lng between ${box.minLng} and ${box.maxLng}`
	);
}

/**
 * The boxes as one OR. Not a predicate any query should use (SQLite cannot
 * match a partial index with it, see region.ts) — it is here purely to prove
 * the stored `region` column agrees with today's boxes.
 */
const ANY_REGION_SQL = TRACKED_REGION_IDS.map((id) => `(${boxText(id)})`).join(
	" or ",
);

// ---------------------------------------------------------------------------
// 1. The generated column matches the boxes the code uses

const tableDdl = (
	sqlite
		.prepare("select sql from sqlite_master where type = 'table' and name = ?")
		.get("transactions") as { sql: string } | undefined
)?.sql;
check(Boolean(tableDdl), "transactions table exists");
check(
	Boolean(tableDdl && norm(tableDdl).includes(norm(REGION_CASE_SQL))),
	"transactions.region is the current REGION_CASE_SQL",
	tableDdl && !norm(tableDdl).includes(norm(REGION_CASE_SQL))
		? `stored DDL did not contain: ${REGION_CASE_SQL}`
		: "",
);

// ---------------------------------------------------------------------------
// 2. Both partial indexes exist with the exact predicates the code uses

const indexSql = (name: string): string => {
	const row = sqlite
		.prepare("select sql from sqlite_master where type = 'index' and name = ?")
		.get(name) as { sql: string } | undefined;
	return row?.sql ?? "";
};
check(
	norm(indexSql("transactions_region_price_idx")).endsWith(
		norm(`where ${REGION_PREDICATE_SQL}`),
	),
	"region index carries REGION_PREDICATE_SQL",
	indexSql("transactions_region_price_idx"),
);
check(
	norm(indexSql("transactions_region_date_idx")).endsWith(
		norm(`where ${REGION_PREDICATE_SQL}`),
	),
	"region date index carries REGION_PREDICATE_SQL",
	indexSql("transactions_region_date_idx"),
);
check(
	indexSql("transactions_malopolska_price_idx") === "",
	"the retired małopolskie-only index is gone (one region index serves all)",
	indexSql("transactions_malopolska_price_idx"),
);

// Every route-shaped aggregation must ride the regional index, not the table.
const planFor = (predicate: string): string =>
	sqlite
		.prepare(
			`explain query plan
			 select substr(datetime(date, 'unixepoch'), 1, 7) as month, avg(pricePerM2)
			 from transactions
			 where ${predicate} and pricePerM2 between 500 and 40000
			 group by month`,
		)
		.all()
		.map((r) => String((r as { detail: string }).detail))
		.join(" | ");

const regionPlan = planFor(REGION_PREDICATE_SQL);
check(
	regionPlan.includes("transactions_region_price_idx") &&
		!regionPlan.includes("SCAN transactions"),
	"region-wide aggregation is index-driven",
	regionPlan,
);
const countPlan = sqlite
	.prepare(
		`explain query plan
		 select substr(parcel_id, 1, 4) as teryt, count(*) as tx
		 from transactions
		 where ${REGION_PREDICATE_SQL} and parcel_id is not null and date >= 0
		 group by teryt`,
	)
	.all()
	.map((r) => String((r as { detail: string }).detail))
	.join(" | ");
check(
	countPlan.includes("transactions_region_date_idx") &&
		!countPlan.includes("SCAN transactions"),
	"per-powiat last-year count rides the region date index",
	countPlan,
);
for (const id of TRACKED_REGION_IDS) {
	const plan = planFor(regionPredicate(id));
	check(
		plan.includes("transactions_region_price_idx") &&
			!plan.includes("SCAN transactions"),
		`${id}-only aggregation stays bounded by the region index`,
		plan,
	);
}

// ---------------------------------------------------------------------------
// 3. The three region lists agree

for (const id of TRACKED_REGION_IDS) {
	const crawler = REGIONS.find((r) => r.id === id);
	check(Boolean(crawler), `crawler/regions.ts lists ${id}`);
	if (!crawler) continue;
	const box = TRACKED_REGIONS[id];
	const same =
		crawler.bbox.minLat === box.minLat &&
		crawler.bbox.maxLat === box.maxLat &&
		crawler.bbox.minLng === box.minLng &&
		crawler.bbox.maxLng === box.maxLng;
	check(
		same,
		`bboxes agree for ${id}`,
		same
			? ""
			: `sql ${JSON.stringify(box)} vs crawler ${JSON.stringify(crawler.bbox)}`,
	);
}
check(
	TRACKED_REGION_IDS.every((id) =>
		(OSM_REGIONS as readonly string[]).includes(id),
	),
	"every tracked region has a Geofabrik extract in OSM_REGIONS",
	`tracked ${TRACKED_REGION_IDS.join(", ")} vs osm ${OSM_REGIONS.join(", ")}`,
);

// ---------------------------------------------------------------------------
// 4. regionOf (the in-process twin) and the stored column agree

const PROBES: Array<[string, number, number, TrackedRegion | null]> = [
	["Kraków", 50.0614, 19.9366, "malopolskie"],
	["Katowice", 50.2577, 19.0259, "slaskie"],
	["Zakopane", 49.2969, 19.9486, "malopolskie"],
	["Gliwice", 50.2945, 18.671, "slaskie"],
	["Bytom", 50.3478, 18.9232, "slaskie"],
	["Kielce (outside)", 50.8703, 20.6275, null],
	["Warszawa (outside)", 52.2297, 21.0122, null],
	["Brno (outside)", 49.1951, 16.6068, null],
];
for (const [label, lat, lng, expected] of PROBES) {
	const got = regionOf(lat, lng);
	check(
		got === expected,
		`regionOf(${label})`,
		`${String(got)} (expected ${String(expected)})`,
	);
}

/** Full-table invariant: no in-region row may be left without a region. */
const unlabelled = Number(
	db.get<{ n: number }>(sql`
		select count(*) as n from transactions
		where region is null and lat is not null and lng is not null
		  and (${sql.raw(ANY_REGION_SQL)})
	`)?.n ?? -1,
);
check(unlabelled === 0, "no in-region row is unlabelled", `${unlabelled} rows`);

const mislabelled = Number(
	db.get<{ n: number }>(sql`
		select count(*) as n from transactions
		where region is not null
		  and lat is not null and lng is not null
		  and not (${sql.raw(ANY_REGION_SQL)})
	`)?.n ?? -1,
);
check(
	mislabelled === 0,
	"no out-of-region row is labelled",
	`${mislabelled} rows`,
);

/**
 * The single-voivodeship slices must partition the region exactly: the CASE
 * assigns the overlap strip (Kraków-Częstochowa) to one voivodeship, so the
 * slices cannot overlap or leave a hole.
 */
let sliceRows = 0;
for (const id of TRACKED_REGION_IDS) {
	sliceRows += Number(
		db.get<{ n: number }>(
			sql`select count(*) as n from transactions where ${inRegion(id)}`,
		)?.n ?? -1,
	);
}
const regionRows = Number(
	db.get<{ n: number }>(
		sql`select count(*) as n from transactions where ${inTrackedRegions}`,
	)?.n ?? -1,
);
check(
	sliceRows === regionRows,
	"voivodeship slices partition the region rows",
	`${sliceRows} sliced vs ${regionRows} region-wide`,
);

/** Sampled twin comparison: the CASE order is the overlap tie-breaker. */
const sample = sqlite
	.prepare(
		"select lat, lng, region from transactions where id % 997 = 1 and lat is not null and region is not null limit 5000",
	)
	.all() as Array<{ lat: number; lng: number; region: string | null }>;
let mismatches = 0;
for (const row of sample) {
	if (regionOf(row.lat, row.lng) !== row.region) mismatches++;
}
check(
	mismatches === 0,
	"regionOf agrees with the stored column on a 5000-row sample",
	`${mismatches}/${sample.length} mismatches`,
);

console.log(
	failures === 0
		? `\nAll region-scope checks passed (${sample.length} sampled rows).`
		: `\n${failures} region-scope check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
