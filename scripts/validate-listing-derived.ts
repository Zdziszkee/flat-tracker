/**
 * Pin the denormalized listing fields against their pure definitions.
 *
 * `recomputeListingDerived` moved the 47k-row visibility/kind pass out of the
 * request path. A drift there silently changes what the map and table show, so
 * this compares every stored value with `visibleListingIds` and
 * `propertyKindOf`, and the SQL facet counts with `listingFacets`.
 *
 * Run with `bun run validate:listing-derived`.
 */
import { desc, eq, sql } from "drizzle-orm";

import { db } from "../src/db/index.ts";
import { recomputeListingDerived } from "../src/db/listing-derived.ts";
import { buildings, listings } from "../src/db/schema.ts";
import { listingFacets } from "../src/lib/listing-features.ts";
import { visibleListingIds } from "../src/lib/listing-visibility.ts";
import { propertyKindOf, type PropertyKind } from "../src/lib/property-kind.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

recomputeListingDerived();

const rows = await db
	.select({
		id: listings.id,
		source: listings.source,
		externalId: listings.externalId,
		title: listings.title,
		address: listings.address,
		features: listings.features,
		price: listings.price,
		areaM2: listings.areaM2,
		rooms: listings.rooms,
		district: listings.district,
		propertyType: listings.propertyType,
		lat: listings.lat,
		lng: listings.lng,
		buildingLat: buildings.lat,
		buildingLng: buildings.lng,
		listedAt: listings.listedAt,
		firstSeenAt: listings.firstSeenAt,
		propertyKind: listings.propertyKind,
		isVisible: listings.isVisible,
		mapLat: listings.mapLat,
		mapLng: listings.mapLng,
		derivedAt: listings.derivedAt,
	})
	.from(listings)
	.leftJoin(buildings, eq(listings.buildingId, buildings.id))
	// Same order as `recomputeListingDerived`: the morizon/gratka dedupe keeps
	// the first row it sees, so an unordered read would compare a different
	// rule than the one that wrote the stored values.
	.orderBy(desc(listings.scrapedAt));

check(rows.length > 0, "listings table is not empty");
check(
	rows.every((row) => row.derivedAt != null),
	"every row has a derived_at marker",
);

const expectedVisible = visibleListingIds(rows);
const visibleMismatch = rows.filter(
	(row) => expectedVisible.has(row.id) !== row.isVisible,
);
check(
	visibleMismatch.length === 0,
	`stored is_visible matches the pure rule (${visibleMismatch.length} mismatches, ${expectedVisible.size} visible)`,
);

const kindMismatch = rows.filter((row) => {
	const expected = propertyKindOf({
		source: row.source,
		title: row.title,
		propertyType: row.propertyType,
		externalId: row.externalId,
	});
	return row.propertyKind !== expected;
});
check(
	kindMismatch.length === 0,
	`stored property_kind matches propertyKindOf (${kindMismatch.length} mismatches)`,
);

const anchorMismatch = rows.filter((row) => {
	const expectedLat = row.buildingLat ?? row.lat;
	const expectedLng = row.buildingLng ?? row.lng;
	return row.mapLat !== expectedLat || row.mapLng !== expectedLng;
});
check(
	anchorMismatch.length === 0,
	`stored map anchor matches building/own coordinates (${anchorMismatch.length} mismatches)`,
);

// SQL facets must agree with the shared pure counting rule the old route used.
const sqlGroups = await db
	.select({
		source: listings.source,
		kind: listings.propertyKind,
		count: sql<number>`count(*)`,
	})
	.from(listings)
	.where(eq(listings.isVisible, true))
	.groupBy(listings.source, listings.propertyKind);

const visibleRows = rows
	.filter((row) => row.isVisible)
	.map((row) => ({
		externalId: row.externalId,
		source: row.source,
		propertyKind: row.propertyKind as PropertyKind | null,
		listedAt: row.listedAt?.toISOString() ?? null,
		firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
	}));
const pureAll = listingFacets(visibleRows, 0);
const sqlTotal = sqlGroups.reduce((sum, row) => sum + Number(row.count), 0);
check(
	sqlTotal === pureAll.total,
	`SQL facet total (${sqlTotal}) matches the pure rule (${pureAll.total})`,
);
const sqlBySource = new Map<string, number>();
const sqlByKind = new Map<PropertyKind, number>();
for (const row of sqlGroups) {
	sqlBySource.set(
		row.source,
		(sqlBySource.get(row.source) ?? 0) + Number(row.count),
	);
	if (
		row.kind === "apartment" ||
		row.kind === "house" ||
		row.kind === "plot"
	) {
		sqlByKind.set(row.kind, (sqlByKind.get(row.kind) ?? 0) + Number(row.count));
	}
}
check(
	[...pureAll.bySource.entries()].every(
		([source, count]) => sqlBySource.get(source) === count,
	) && sqlBySource.size === pureAll.bySource.size,
	"SQL by-source counts match the pure rule",
);
check(
	[...pureAll.byKind.entries()].every(
		([kind, count]) => sqlByKind.get(kind) === count,
	) && sqlByKind.size === pureAll.byKind.size,
	"SQL by-kind counts match the pure rule",
);

for (const days of [0, 1, 7, 30] as const) {
	const pure = listingFacets(visibleRows, days);
	const expected = visibleRows.filter((row) => {
		if (days === 0) return true;
		const added = row.listedAt ?? row.firstSeenAt;
		if (!added) return false;
		return Date.now() - new Date(added).getTime() <= days * 86_400_000;
	}).length;
	check(
		pure.total === expected,
		`pure facet total for days=${days} (${pure.total})`,
	);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exitCode = 1;
} else {
	console.log("\nAll listing-derived checks passed");
}
process.exit(process.exitCode ?? 0);
