import "dotenv/config";

import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, listings, osmBuildings, transactions } from "#/db/schema";
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
 * Usage: bun run assign-buildings
 */
export async function assignBuildings(): Promise<{
	listings: number;
	transactions: number;
	addressBackfilled: number;
	buildYears: number;
}> {
	// The OSM index is the matcher; build it from the Geofabrik extract once.
	// (Inside the function, not at module load: refresh.ts imports this module
	// to call assignBuildings, and an import must not start a second pass.)
	if (!(await osmIndexReady())) {
		console.log("Local OSM index missing, building from Geofabrik extract...");
		await buildOsmIndex();
	}
	console.log("Assigning buildings to listings...");
	const listings = await assignBuildingsToListingsLocal();
	console.log(`  ${listings} listings assigned`);

	console.log("Assigning buildings to transactions (address-first)...");
	const transactions = await assignBuildingsToTransactionsLocal();
	console.log(`  ${transactions} transactions assigned by address`);

	console.log("Backfilling building addresses from transactions...");
	const addressBackfilled = await backfillBuildingAddresses();
	console.log(
		`  ${addressBackfilled} buildings got an address from transactions`,
	);

	console.log("Deriving building years...");
	const buildYears = await updateBuildingYears();
	console.log(`  ${buildYears} buildings now have a construction year`);

	return { listings, transactions, addressBackfilled, buildYears };
}

/**
 * buildings.build_year: the average year of the flats anchored to the
 * building (otodom detail pages carry "Rok budowy" for every flat of a
 * house), falling back to the OSM `start_date` tag. Buildings with neither
 * stay null rather than guessing.
 */
export async function updateBuildingYears(): Promise<number> {
	const year = sql`coalesce(
		(select round(avg(l.build_year)) from ${listings} l
		 where l.building_id = ${buildings.id} and l.build_year between 1700 and 2100),
		(select case
			when cast(substr(json_extract(${buildings.tags}, '$.start_date'), 1, 4) as integer)
				between 1700 and 2100
			then cast(substr(json_extract(${buildings.tags}, '$.start_date'), 1, 4) as integer)
		end)
	)`;
	await db.run(
		sql`update ${buildings} set build_year = ${year} where ${year} is not null`,
	);
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(buildings)
		.where(isNotNull(buildings.buildYear));
	return row?.n ?? 0;
}

/** CLI alias kept for `bun run assign-buildings`. */
async function main() {
	await assignBuildings();
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

/**
 * Coverage of the local `osm_buildings` index (union of every footprint
 * box). Assignment is scoped to it because the RCN import is national
 * while the OSM extract is małopolska-wide: without the filter, a national
 * drain would drag ~20M out-of-region rows through rbush (and into memory)
 * on every refresh, only to match none of them.
 */
async function osmCoverage(): Promise<{
	minLat: number;
	maxLat: number;
	minLng: number;
	maxLng: number;
} | null> {
	const [row] = await db
		.select({
			minLat: sql<number>`min(${osmBuildings.bboxMinLat})`,
			maxLat: sql<number>`max(${osmBuildings.bboxMaxLat})`,
			minLng: sql<number>`min(${osmBuildings.bboxMinLng})`,
			maxLng: sql<number>`max(${osmBuildings.bboxMaxLng})`,
		})
		.from(osmBuildings);
	if (row?.minLat == null || row.maxLat == null) return null;
	return {
		minLat: row.minLat,
		maxLat: row.maxLat,
		minLng: row.minLng,
		maxLng: row.maxLng,
	};
}

async function assignBuildingsToTransactionsLocal(): Promise<number> {
	const coverage = await osmCoverage();
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
		.where(
			coverage
				? and(
						isNotNull(transactions.lat),
						gte(transactions.lat, coverage.minLat),
						lte(transactions.lat, coverage.maxLat),
						gte(transactions.lng, coverage.minLng),
						lte(transactions.lng, coverage.maxLng),
					)
				: isNotNull(transactions.lat),
		);

	if (all.length === 0) return 0;
	const tree = await loadOsmIndex();
	const streetIndex = await buildStreetIndex();

	// Writes are batched: a statement per transaction turned this pass into
	// hours on the full registry (~1M rows). Grouping by building keeps every
	// statement a plain `where id in (...)`.
	const pending = new Map<number, number[]>();
	let queued = 0;
	const queue = (buildingId: number, id: number) => {
		const ids = pending.get(buildingId);
		if (ids) ids.push(id);
		else pending.set(buildingId, [id]);
		queued++;
	};
	const flush = async () => {
		const entries = [...pending];
		pending.clear();
		queued = 0;
		for (const [buildingId, ids] of entries) {
			for (let i = 0; i < ids.length; i += 400) {
				await db
					.update(transactions)
					.set({ buildingId })
					.where(inArray(transactions.id, ids.slice(i, i + 400)));
			}
		}
	};

	let byAddress = 0;
	let byGeo = 0;
	for (const t of all) {
		if (t.lat === null || t.lng === null) continue;

		// 1. Exact address match (RCN street + number -> OSM building).
		// The index is małopolska-wide, so the same street + number can
		// exist in several towns; the transaction's own coordinates gate
		// the match to buildings within ~300 m (same-town distances).
		const addrMatch = matchByAddress(
			streetIndex,
			t.street,
			t.streetNumber,
			null,
			t.lat !== null && t.lng !== null ? { lat: t.lat, lng: t.lng } : undefined,
		);
		if (addrMatch) {
			const buildingId = await ensureBuildingByOsmId(
				addrMatch.osmId,
				addrMatch.lat,
				addrMatch.lng,
			);
			if (buildingId !== null && buildingId !== t.buildingId) {
				queue(buildingId, t.id);
				byAddress++;
				if (queued >= 50_000) await flush();
			}
			continue;
		}

		// 2. Geo fallback: point-in-polygon, then street-aware 150m.
		const b = matchPointStreetAware(tree, t.lat, t.lng, t.street);
		if (!b) continue;
		const buildingId = await ensureBuilding(b);
		if (buildingId !== null && buildingId !== t.buildingId) {
			queue(buildingId, t.id);
			byGeo++;
			if (queued >= 50_000) await flush();
		}
	}
	await flush();
	console.log(`  address matches: ${byAddress}, geo fallback: ${byGeo}`);
	return byAddress + byGeo;
}

/**
 * buildings.id by osmId. One pass touches the same building from thousands
 * of transactions, and without this it did a SELECT per row.
 */
const buildingIdByOsmId = new Map<number, number>();

/** Insert into the `buildings` table if not already present, return its id. */
async function ensureBuilding(b: OsmBuilding): Promise<number | null> {
	const cached = buildingIdByOsmId.get(b.osmId);
	if (cached !== undefined) return cached;
	const existing = await db.query.buildings.findFirst({
		where: (row) => eq(row.osmId, b.osmId),
	});
	if (existing) {
		buildingIdByOsmId.set(b.osmId, existing.id);
		return existing.id;
	}

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
	if (row) buildingIdByOsmId.set(b.osmId, row.id);
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
	if (existing) {
		buildingIdByOsmId.set(osmId, existing.id);
		return existing.id;
	}

	const [row] = await db
		.insert(buildings)
		.values({ osmId, lat, lng })
		.onConflictDoNothing()
		.returning({ id: buildings.id });
	if (row) buildingIdByOsmId.set(osmId, row.id);
	return row?.id ?? null;
}

/** CLI entry: `bun run assign-buildings`. */
if (process.argv[1]?.replace(/\\/g, "/").endsWith("assign-buildings.ts")) {
	main().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
