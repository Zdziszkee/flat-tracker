/**
 * Validate the parcel enrichment layer.
 *
 * Checks the migration, the geometry helpers, and the coverage/sanity of
 * `parcel_features`. Exit code 1 on any failed check.
 *
 * Run: bun run validate:parcel-features
 */

import "dotenv/config";

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { pointInRing, ringAreaM2 } from "#/crawler/egib.ts";

interface Check {
	name: string;
	ok: boolean;
	detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: string): void {
	checks.push({ name, ok, detail });
}

function tableExists(name: string): boolean {
	const row = db.get(
		sql`select name from sqlite_master where type = 'table' and name = ${name}`,
	) as { name?: string } | undefined;
	return row?.name === name;
}

function columnExists(table: string, column: string): boolean {
	const rows = db.all(
		sql`select name from pragma_table_info(${table})`,
	) as Array<{ name: string }>;
	return rows.some((r) => r.name === column);
}

function count(query: ReturnType<typeof sql>): number {
	const row = db.get(query) as { n?: number } | undefined;
	return Number(row?.n ?? 0);
}

// 1. Migration.
check("parcel_features table exists", tableExists("parcel_features"), "");
check("osm_roads table exists", tableExists("osm_roads"), "");
check(
	"listings.parcel_id exists",
	columnExists("listings", "parcel_id"),
	"",
);
check(
	"parcels.land_use_class exists",
	columnExists("parcels", "land_use_class"),
	"",
);

// 2. Geometry helpers on a 100 m square near Krakow.
const lat = 50.06;
const dLat = 100 / 110_574;
const dLng = 100 / (111_320 * Math.cos((lat * Math.PI) / 180));
const square = [
	{ lat: lat - dLat / 2, lng: 19.94 - dLng / 2 },
	{ lat: lat - dLat / 2, lng: 19.94 + dLng / 2 },
	{ lat: lat + dLat / 2, lng: 19.94 + dLng / 2 },
	{ lat: lat + dLat / 2, lng: 19.94 - dLng / 2 },
];
const area = ringAreaM2(square);
check(
	"ringAreaM2 gives 10,000 m2 for a 100 m square",
	Math.abs(area - 10_000) < 200,
	`${area.toFixed(1)} m2`,
);
check(
	"pointInRing accepts the centre",
	pointInRing(square, lat, 19.94),
	"",
);
check(
	"pointInRing rejects a point 200 m outside",
	!pointInRing(square, lat + 200 / 110_574, 19.94),
	"",
);

// 3. Coverage.
const linkedListings = count(sql`
	select count(*) as n from listings
	where lat is not null and lng is not null
`);
const assignedListings = count(sql`
	select count(*) as n from listings where parcel_id is not null
`);
check(
	"at least one listing is bound to a parcel",
	assignedListings > 0,
	`${assignedListings}/${linkedListings} listings`,
);

const linkedParcels = count(sql`
	select count(*) as n from (
		select distinct parcel_id from listings where parcel_id is not null
		union
		select distinct parcel_id from transactions where parcel_id is not null
	)
`);
const featureRows = count(sql`select count(*) as n from parcel_features`);
check(
	"parcel_features covers linked parcels",
	featureRows > 0 && featureRows <= linkedParcels,
	`${featureRows}/${linkedParcels} linked parcels`,
);

const badArea = count(sql`
	select count(*) as n from parcel_features where area_m2 is not null and area_m2 <= 0
`);
check("every measured area is positive", badArea === 0, `${badArea} bad rows`);

const badCoverage = count(sql`
	select count(*) as n from parcel_features
	where building_coverage is not null and (building_coverage < 0 or building_coverage > 1)
`);
check(
	"building coverage is within 0..1",
	badCoverage === 0,
	`${badCoverage} bad rows`,
);

const badRoad = count(sql`
	select count(*) as n from parcel_features
	where (road_distance_m is not null and road_distance_m < 0)
	   or (frontage_m is not null and frontage_m < 0)
`);
check("road distance and frontage are non-negative", badRoad === 0, `${badRoad} bad rows`);

const badZoning = count(sql`
	select count(*) as n from parcel_features
	where zoning_flags is not null and json_valid(zoning_flags) = 0
`);
check("zoning flags are valid JSON", badZoning === 0, `${badZoning} bad rows`);

const badSlope = count(sql`
	select count(*) as n from parcel_features
	where slope_deg is not null and (slope_deg < 0 or slope_deg > 90)
`);
check("slope is within 0..90 degrees", badSlope === 0, `${badSlope} bad rows`);

const badFlood = count(sql`
	select count(*) as n from parcel_features
	where flood_risk is not null and flood_risk not in (0, 1)
`);
check("flood risk is boolean", badFlood === 0, `${badFlood} bad rows`);

const terrainRows = count(sql`
	select count(*) as n from parcel_features where elevation_m is not null
`);
check("at least one parcel has terrain", terrainRows > 0, `${terrainRows} rows`);

// 4. Source coverage.
const roads = count(sql`select count(*) as n from osm_roads`);
check("osm_roads is populated", roads > 0, `${roads} roads`);

const egibParcels = count(sql`
	select count(*) as n from parcels where source = 'egib'
`);
check("EGiB parcels are populated", egibParcels > 0, `${egibParcels} parcels`);

// Report.
const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
	console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
