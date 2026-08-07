import "dotenv/config";

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, listings, transactions } from "#/db/schema";
import { buildStreetIndex, matchByAddress } from "./address-index.ts";
import {
	buildOsmIndex,
	loadOsmIndex,
	matchPointLocal,
	matchPointStreetAware,
	type OsmBuilding,
	osmIndexReady,
} from "./osm-index.ts";

/**
 * Assigns OSM buildings to every listing and transaction.
 *
 * Listings: point-in-polygon against the local osm_buildings index.
 * Transactions: EXACT address match first (RCN street + housenumber vs
 * OSM addr:street + addr:housenumber), then point-in-polygon, then a
 * street-aware 150m fallback. Transactions without an address match use
 * the geo fallbacks directly.
 *
 * Also backfills buildings.address from RCN transactions (most common
 * street + housenumber among the building's transactions) when the
 * building has no OSM address.
 *
 * Usage: npm run assign-buildings
 */
async function main() {
	console.log("Assigning buildings to listings...");
	const listingsDone = await assignBuildingsToListingsLocal();
	console.log(`  ${listingsDone} listings assigned`);

	console.log("Assigning buildings to transactions (address-first)...");
	const txDone = await assignBuildingsToTransactionsLocal();
	console.log(`  ${txDone} transactions assigned by address`);

	console.log("Backfilling building addresses from transactions...");
	const backfilled = await backfillBuildingAddresses();
	console.log(`  ${backfilled} buildings got an address from transactions`);
}

/** buildings.address from the most common (street, number) in its txns. */
async function backfillBuildingAddresses(): Promise<number> {
	const result = await db
		.update(buildings)
		.set({
			address: sql`(
				select trim(t.street || ' ' || coalesce(t.streetNumber, ''))
				from ${transactions} t
				where t.building_id = ${buildings.id}
				  and t.street is not null and t.street != ''
				group by t.street, t.streetNumber
				order by count(*) desc, max(t.date) desc
				limit 1
			)`,
		})
		.where(
			sql`${buildings.address} is null and exists (
				select 1 from ${transactions} t
				where t.building_id = ${buildings.id}
				  and t.street is not null and t.street != ''
			)`,
		)
		.returning({ id: buildings.id });
	return result.length;
}

async function assignBuildingsToListingsLocal(): Promise<number> {
	const unassigned = await db
		.select({ id: listings.id, lat: listings.lat, lng: listings.lng })
		.from(listings)
		.where(and(isNull(listings.buildingId), isNotNull(listings.lat)));

	if (unassigned.length === 0) return 0;
	const tree = await loadOsmIndex();

	let assigned = 0;
	for (const l of unassigned) {
		if (l.lat === null || l.lng === null) continue;
		const b = matchPointLocal(tree, l.lat, l.lng, 40);
		if (!b) continue;
		const buildingId = await ensureBuilding(b);
		if (buildingId !== null) {
			await db
				.update(listings)
				.set({ buildingId })
				.where(eq(listings.id, l.id));
			assigned++;
		}
	}
	return assigned;
}

async function assignBuildingsToTransactionsLocal(): Promise<number> {
	const all = await db
		.select({
			id: transactions.id,
			lat: transactions.lat,
			lng: transactions.lng,
			street: transactions.street,
			streetNumber: transactions.streetNumber,
			buildingId: transactions.buildingId,
		})
		.from(transactions)
		.where(isNotNull(transactions.lat));

	if (all.length === 0) return 0;
	const tree = await loadOsmIndex();
	const streetIndex = await buildStreetIndex();

	let byAddress = 0;
	let byGeo = 0;
	for (const t of all) {
		if (t.lat === null || t.lng === null) continue;

		// 1. Exact address match (RCN street + number -> OSM building).
		const addrMatch = matchByAddress(streetIndex, t.street, t.streetNumber);
		if (addrMatch) {
			const buildingId = await ensureBuildingByOsmId(
				addrMatch.osmId,
				addrMatch.lat,
				addrMatch.lng,
			);
			if (buildingId !== null && buildingId !== t.buildingId) {
				await db
					.update(transactions)
					.set({ buildingId })
					.where(eq(transactions.id, t.id));
				byAddress++;
			}
			continue;
		}

		// 2. Geo fallback: point-in-polygon, then street-aware 150m.
		const b = matchPointStreetAware(tree, t.lat, t.lng, t.street);
		if (!b) continue;
		const buildingId = await ensureBuilding(b);
		if (buildingId !== null && buildingId !== t.buildingId) {
			await db
				.update(transactions)
				.set({ buildingId })
				.where(eq(transactions.id, t.id));
			byGeo++;
		}
	}
	console.log(`  address matches: ${byAddress}, geo fallback: ${byGeo}`);
	return byAddress + byGeo;
}

/** Insert into the `buildings` table if not already present, return its id. */
async function ensureBuilding(b: OsmBuilding): Promise<number | null> {
	const existing = await db.query.buildings.findFirst({
		where: (row) => eq(row.osmId, b.osmId),
	});
	if (existing) return existing.id;

	const [row] = await db
		.insert(buildings)
		.values({
			osmId: b.osmId,
			lat: b.centroidLat,
			lng: b.centroidLng,
			address: b.address,
			tags: b.tags ? JSON.stringify(b.tags) : null,
			geometry: JSON.stringify(b.polygon),
		})
		.onConflictDoNothing()
		.returning({ id: buildings.id });
	return row?.id ?? null;
}

/** Same as ensureBuilding, but from an address-index match (osmId + point). */
async function ensureBuildingByOsmId(
	osmId: number,
	lat: number,
	lng: number,
): Promise<number | null> {
	const existing = await db.query.buildings.findFirst({
		where: (row) => eq(row.osmId, osmId),
	});
	if (existing) return existing.id;

	const [row] = await db
		.insert(buildings)
		.values({ osmId, lat, lng })
		.onConflictDoNothing()
		.returning({ id: buildings.id });
	return row?.id ?? null;
}

// Build the local index on first run.
if (!(await osmIndexReady())) {
	console.log("Local OSM index missing, building from Geofabrik extract...");
	await buildOsmIndex();
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
