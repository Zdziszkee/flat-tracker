import "dotenv/config";

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { buildings, listings, transactions } from "#/db/schema";
import {
  buildOsmIndex,
  loadOsmIndex,
  matchPointLocal,
  osmIndexReady,
  type OsmBuilding,
} from "./osm-index.ts";

/**
 * Assigns OSM buildings to every listing and transaction that has
 * coordinates but no building yet, using the local osm_buildings index
 * (Geofabrik extract, point-in-polygon). Built on first run.
 *
 * Usage: npm run assign-buildings
 */
async function main() {
  console.log("Assigning buildings to listings...");
  const listingsDone = await assignBuildingsToListingsLocal();
  console.log(`  ${listingsDone} listings assigned`);

  console.log("Assigning buildings to transactions...");
  const txDone = await assignBuildingsToTransactionsLocal();
  console.log(`  ${txDone} transactions assigned`);
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
  const unassigned = await db
    .select({ id: transactions.id, lat: transactions.lat, lng: transactions.lng })
    .from(transactions)
    .where(and(isNull(transactions.buildingId), isNotNull(transactions.lat)));

  if (unassigned.length === 0) return 0;
  const tree = await loadOsmIndex();

  let assigned = 0;
  for (const t of unassigned) {
    if (t.lat === null || t.lng === null) continue;
    const b = matchPointLocal(tree, t.lat, t.lng, 40);
    if (!b) continue;
    const buildingId = await ensureBuilding(b);
    if (buildingId !== null) {
      await db
        .update(transactions)
        .set({ buildingId })
        .where(eq(transactions.id, t.id));
      assigned++;
    }
  }
  return assigned;
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

// Build the local index on first run.
if (!(await osmIndexReady())) {
  console.log("Local OSM index missing, building from Geofabrik extract...");
  await buildOsmIndex();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
