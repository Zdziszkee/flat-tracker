import { and, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { listings } from "#/db/schema";

import type { Listing } from "./types.ts";

/**
 * Upsert listings into SQLite by (source, externalId). Detail-page records
 * (with coordinates) overwrite list-page records for the same ad, making
 * crawls idempotent and self-refining.
 */
export async function saveListings(list: Listing[]): Promise<number> {
	if (list.length === 0) return 0;

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

	const result = await db
		.insert(listings)
		.values(rows)
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
				lat: sql.raw(`excluded.lat`),
				lng: sql.raw(`excluded.lng`),
				listedAt: sql.raw(`excluded.listed_at`),
				scrapedAt: sql.raw(`excluded.scraped_at`),
			},
		})
		.returning({ id: listings.id });

	return result.length;
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
