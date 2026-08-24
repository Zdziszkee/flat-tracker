import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { crawlRuns, listingHistory, listings } from "#/db/schema";

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
function featureString(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v : null;
}

function featureNumber(v: unknown): number | null {
	const n =
		typeof v === "string"
			? Number.parseFloat(v)
			: typeof v === "number"
				? v
				: Number.NaN;
	return Number.isFinite(n) ? n : null;
}

/** Promote the analytics-hot attributes out of the features JSON blob. */
function extractFeatureFields(features: string | null): {
	market: string | null;
	buildYear: number | null;
	buildingMaterial: string | null;
	floorCount: number | null;
	condition: string | null;
	ownership: string | null;
} {
	const out = {
		market: null as string | null,
		buildYear: null as number | null,
		buildingMaterial: null as string | null,
		floorCount: null as number | null,
		condition: null as string | null,
		ownership: null as string | null,
	};
	if (!features) return out;
	try {
		const f = JSON.parse(features) as Record<string, unknown>;
		out.market = featureString(f.market);
		out.buildYear = featureNumber(f.build_year);
		out.buildingMaterial = featureString(f.building_material);
		out.floorCount =
			featureNumber(f.building_floors_num) ?? featureNumber(f.floor_count);
		out.condition =
			featureString(f.condition) ??
			featureString(f.construction_status) ??
			featureString(f.finish_state);
		out.ownership =
			featureString(f.building_ownership) ?? featureString(f.ownership);
	} catch {
		// Unparseable features blob: keep the promoted columns null.
	}
	return out;
}

/**
 * Upsert listings into SQLite by (source, externalId). Detail-page records
 * (with coordinates) overwrite list-page records for the same ad, making
 * crawls idempotent and self-refining. A price/area change also appends a
 * `listing_history` snapshot for time-series analytics.
 */
export async function saveListings(list: Listing[]): Promise<SaveReport> {
	if (list.length === 0) return { newCount: 0, updatedCount: 0 };

	// A crawl run is single-source, but keep it safe for multi-source batches.
	const sources = [...new Set(list.map((l) => l.source))];
	const existing = new Map<
		string,
		{
			id: number;
			price: number | null;
			pricePerM2: number | null;
			areaM2: number | null;
		}
	>();
	for (const source of sources) {
		const ids = list
			.filter((l) => l.source === source)
			.map((l) => l.externalId);
		const rows = await db
			.select({
				id: listings.id,
				externalId: listings.externalId,
				price: listings.price,
				pricePerM2: listings.pricePerM2,
				areaM2: listings.areaM2,
			})
			.from(listings)
			.where(
				and(eq(listings.source, source), inArray(listings.externalId, ids)),
			);
		for (const r of rows) {
			existing.set(`${source}:${r.externalId}`, {
				id: r.id,
				price: r.price,
				pricePerM2: r.pricePerM2,
				areaM2: r.areaM2,
			});
		}
	}

	const newCount = list.filter(
		(l) => !existing.has(`${l.source}:${l.externalId}`),
	).length;
	const updatedCount = list.length - newCount;

	const now = new Date();
	const rows = list.map((l) => {
		const f = extractFeatureFields(l.features);
		return {
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
			description: l.description,
			heatingType: l.heatingType,
			propertyType: l.propertyType,
			features: l.features,
			market: f.market,
			buildYear: f.buildYear,
			buildingMaterial: f.buildingMaterial,
			floorCount: f.floorCount,
			condition: f.condition,
			ownership: f.ownership,
			firstSeenAt: now,
			lastSeenAt: now,
			isActive: true,
			lat: l.lat,
			lng: l.lng,
			listedAt: l.listedAt ? new Date(l.listedAt) : null,
			scrapedAt: new Date(l.scrapedAt),
			offerType: l.offerType ?? "sale",
			pricePeriod: l.pricePeriod ?? null,
			minimumStayNights: l.minimumStayNights ?? null,
			rating: l.rating ?? null,
			reviewsCount: l.reviewsCount ?? null,
			availabilityCount: l.availabilityCount ?? null,
			maxGuests: l.maxGuests ?? null,
		};
	});

	// SQLite caps bound variables at ~999 per statement; big feeds
	// (investmap: 5k+ flats per run) need chunked upserts.
	const BATCH = 400;
	for (let i = 0; i < rows.length; i += BATCH) {
		const chunk = rows.slice(i, i + BATCH);
		const returned = await db
			.insert(listings)
			.values(chunk)
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
					description: sql.raw(`excluded.description`),
					heatingType: sql`coalesce(excluded.heating_type, ${listings.heatingType})`,
					propertyType: sql`coalesce(excluded.property_type, ${listings.propertyType})`,
					features: sql`coalesce(excluded.features, ${listings.features})`,
					market: sql`coalesce(excluded.market, ${listings.market})`,
					buildYear: sql`coalesce(excluded.build_year, ${listings.buildYear})`,
					buildingMaterial: sql`coalesce(excluded.building_material, ${listings.buildingMaterial})`,
					floorCount: sql`coalesce(excluded.floor_count, ${listings.floorCount})`,
					condition: sql`coalesce(excluded.condition, ${listings.condition})`,
					ownership: sql`coalesce(excluded.ownership, ${listings.ownership})`,
					// Address-only sources (morizon, domiporta,
					// komornik...) carry no coordinates: keep the geocoded
					// position instead of wiping it with NULL on re-crawl.
					lat: sql`coalesce(excluded.lat, ${listings.lat})`,
					lng: sql`coalesce(excluded.lng, ${listings.lng})`,
					buildingId: sql`coalesce(excluded.building_id, ${listings.buildingId})`,
					// Detail-page records carry no listedAt (the list page owns the
					// "added" date), so keep the existing value instead of wiping it.
					listedAt: sql`coalesce(excluded.listed_at, ${listings.listedAt})`,
					lastSeenAt: sql.raw(`excluded.last_seen_at`),
					deactivatedAt: null,
					isActive: sql.raw(`1`),
					scrapedAt: sql.raw(`excluded.scraped_at`),
					offerType: sql.raw(`excluded.offer_type`),
					pricePeriod: sql.raw(`excluded.price_period`),
					minimumStayNights: sql.raw(`excluded.minimum_stay_nights`),
					rating: sql.raw(`excluded.rating`),
					reviewsCount: sql.raw(`excluded.reviews_count`),
					availabilityCount: sql.raw(`excluded.availability_count`),
					maxGuests: sql.raw(`excluded.max_guests`),
				},
			})
			.returning({
				id: listings.id,
				source: listings.source,
				externalId: listings.externalId,
			});

		const idByKey = new Map(
			returned.map((r) => [`${r.source}:${r.externalId}`, r.id] as const),
		);

		const history: Array<{
			listingId: number;
			price: number | null;
			pricePerM2: number | null;
			areaM2: number | null;
		}> = [];
		for (const row of chunk) {
			const id = idByKey.get(`${row.source}:${row.externalId}`);
			if (id == null) continue;
			const prev = existing.get(`${row.source}:${row.externalId}`);
			if (!prev) continue;
			if (
				prev.price !== row.price ||
				prev.pricePerM2 !== row.pricePerM2 ||
				prev.areaM2 !== row.areaM2
			) {
				history.push({
					listingId: id,
					price: row.price,
					pricePerM2: row.pricePerM2,
					areaM2: row.areaM2,
				});
			}
		}
		if (history.length > 0) {
			await db.insert(listingHistory).values(history);
		}
	}

	return { newCount, updatedCount };
}

/** Record a per-site crawl run for crawler-health analytics. */
export async function recordCrawlRun(run: {
	source: string;
	startedAt: Date;
	finishedAt: Date;
	pages: number;
	newCount: number;
	updatedCount: number;
	error?: string | null;
}): Promise<void> {
	await db.insert(crawlRuns).values({
		source: run.source,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		pages: run.pages,
		newCount: run.newCount,
		updatedCount: run.updatedCount,
		error: run.error ?? null,
	});
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
