import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { listings } from "#/db/schema";

import type { Listing } from "./types.ts";

export interface SaveReport {
	/** Listings that did not exist before this run (the diff of new offers). */
	newCount: number;
	/** Listings that already existed and were overwritten (refined records). */
	updatedCount: number;
}

/**
 * Upsert listings into SQLite by (source, externalId). Detail-page records
 * (with coordinates) overwrite list-page records for the same ad, making
 * crawls idempotent and self-refining.
 *
 * Returns how many rows were NEW versus UPDATED, so a rerun reports the
 * diff of what the portal actually added since the last crawl.
 */
export async function saveListings(list: Listing[]): Promise<SaveReport> {
	if (list.length === 0) return { newCount: 0, updatedCount: 0 };

	// A crawl run is single-source, but keep it safe for multi-source batches.
	const sources = [...new Set(list.map((l) => l.source))];
	const existing = new Set<string>();
	for (const source of sources) {
		const ids = list
			.filter((l) => l.source === source)
			.map((l) => l.externalId);
		const rows = await db
			.select({ externalId: listings.externalId })
			.from(listings)
			.where(
				and(eq(listings.source, source), inArray(listings.externalId, ids)),
			);
		for (const r of rows) existing.add(`${source}:${r.externalId}`);
	}

	const newCount = list.filter(
		(l) => !existing.has(`${l.source}:${l.externalId}`),
	).length;
	const updatedCount = list.length - newCount;

	const rows = list.map((l) => ({
		source: l.source,
		externalId: l.externalId,
		url: l.url,
		title: l.title,
		price: l.price,
		pricePerM2: l.pricePerM2,
		areaM2: l.areaM2,
		rooms: l.rooms,
		floor: l.floor,
		district: l.district,
		address: l.address,
		lat: l.lat,
		lng: l.lng,
		listedAt: l.listedAt ? new Date(l.listedAt) : null,
		scrapedAt: new Date(l.scrapedAt),
	}));

	// SQLite caps bound variables at ~999 per statement; big feeds
	// (investmap: 5k+ flats per run) need chunked upserts.
	const BATCH = 400;
	for (let i = 0; i < rows.length; i += BATCH) {
		await db
			.insert(listings)
			.values(rows.slice(i, i + BATCH))
			.onConflictDoUpdate({
				target: [listings.source, listings.externalId],
				set: {
					url: sql.raw(`excluded.url`),
					title: sql.raw(`excluded.title`),
					price: sql.raw(`excluded.price`),
					pricePerM2: sql.raw(`excluded.pricePerM2`),
					areaM2: sql.raw(`excluded.areaM2`),
					rooms: sql.raw(`excluded.rooms`),
					floor: sql.raw(`excluded.floor`),
					district: sql.raw(`excluded.district`),
					address: sql.raw(`excluded.address`),
					// Address-only sources (morizon, domiporta, skaleczna,
					// komornik...) carry no coordinates: keep the geocoded
					// position instead of wiping it with NULL on re-crawl.
					lat: sql`coalesce(excluded.lat, ${listings.lat})`,
					lng: sql`coalesce(excluded.lng, ${listings.lng})`,
					buildingId: sql`coalesce(excluded.building_id, ${listings.buildingId})`,
					// Detail-page records carry no listedAt (the list page owns the
					// "added" date), so keep the existing value instead of wiping it.
					listedAt: sql`coalesce(excluded.listed_at, ${listings.listedAt})`,
					scrapedAt: sql.raw(`excluded.scraped_at`),
				},
			})
			.returning({ id: listings.id });
	}

	return { newCount, updatedCount };
}

/**
 * Delete portal listings created before `since`. The crawl only fetches
 * postings within the window, so anything older is stale and would
 * otherwise linger in the DB forever.
 */
export async function pruneOldListings(
	since: Date,
	sources: string[] = ["otodom", "olx"],
): Promise<number> {
	const result = await db
		.delete(listings)
		.where(
			and(
				inArray(listings.source, sources),
				isNotNull(listings.listedAt),
				lt(listings.listedAt, since),
			),
		)
		.returning({ id: listings.id });
	return result.length;
}
