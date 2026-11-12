/**
 * Assign cadastral parcels to listings and transactions.
 *
 * RCN transactions already carry a parcel id for the registry rows, but
 * listings only have a building (or raw coordinates). This module finds the
 * parcel that contains each point, using the local `parcels` index first
 * and a single EGiB WFS lookup as a fallback when the region-wide importer
 * has not reached that tile yet.
 *
 * The lookup is bounded per refresh so a national backlog cannot stall the
 * crawl. New listings are always processed first.
 */

import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listings, parcels, transactions } from "#/db/schema";
import {
	type EgibParcel,
	fetchParcelAtPoint,
	parseParcelRing,
	pointInRing,
	ringAreaM2,
} from "./egib.ts";

export interface AssignParcelsOptions {
	/** Max unassigned listings to process this run. Default 500. */
	listingLimit?: number;
	/** Max unassigned transactions to process this run. Default 200. */
	transactionLimit?: number;
	/** Allow a single-parcel EGiB WFS lookup when the local index misses. */
	onDemand?: boolean;
}

export interface AssignParcelsReport {
	listings: number;
	transactions: number;
	fetched: number;
	missed: number;
}

interface LocalParcel {
	parcelId: string;
	polygon: string;
	bboxMinLat: number;
	bboxMinLng: number;
	bboxMaxLat: number;
	bboxMaxLng: number;
}

function centroidOf(
	ring: Array<{ lat: number; lng: number }>,
): { lat: number; lng: number } {
	let lat = 0;
	let lng = 0;
	for (const p of ring) {
		lat += p.lat;
		lng += p.lng;
	}
	return { lat: lat / ring.length, lng: lng / ring.length };
}

function bboxOf(ring: Array<{ lat: number; lng: number }>): {
	minLat: number;
	minLng: number;
	maxLat: number;
	maxLng: number;
} {
	let minLat = 90;
	let minLng = 180;
	let maxLat = -90;
	let maxLng = -180;
	for (const p of ring) {
		if (p.lat < minLat) minLat = p.lat;
		if (p.lat > maxLat) maxLat = p.lat;
		if (p.lng < minLng) minLng = p.lng;
		if (p.lng > maxLng) maxLng = p.lng;
	}
	return { minLat, minLng, maxLat, maxLng };
}

/** Insert one EGiB parcel, filling attributes on an existing RCN row too. */
export async function storeEgibParcel(
	p: EgibParcel,
	source = "egib",
): Promise<void> {
	const bbox = bboxOf(p.ring);
	const centroid = centroidOf(p.ring);
	const areaHa = p.areaHa ?? ringAreaM2(p.ring) / 10_000;
	await db
		.insert(parcels)
		.values({
			parcelId: p.parcelId,
			bboxMinLat: bbox.minLat,
			bboxMinLng: bbox.minLng,
			bboxMaxLat: bbox.maxLat,
			bboxMaxLng: bbox.maxLng,
			centroidLat: centroid.lat,
			centroidLng: centroid.lng,
			polygon: JSON.stringify(p.ring),
			source,
			obreb: p.obreb,
			gmina: p.gmina,
			landUseClass: p.landUseClass,
			registerGroup: p.registerGroup,
			egibDataDate: p.egibDataDate,
			areaHa,
		})
		.onConflictDoNothing({ target: parcels.parcelId });

	// RCN rows are imported first and win the insert, but they have no EGiB
	// attributes. Fill only the columns that are still empty.
	await db
		.update(parcels)
		.set({
			landUseClass: p.landUseClass,
			registerGroup: p.registerGroup,
			egibDataDate: p.egibDataDate,
			areaHa,
			obreb: p.obreb,
			gmina: p.gmina,
		})
		.where(
			and(
				eq(parcels.parcelId, p.parcelId),
				sql`${parcels.landUseClass} is null and ${parcels.areaHa} is null`,
			),
		);
}

/** Find the local parcel containing a point, or null. */
async function findLocalParcel(
	lat: number,
	lng: number,
): Promise<LocalParcel | null> {
	const candidates = await db
		.select({
			parcelId: parcels.parcelId,
			polygon: parcels.polygon,
			bboxMinLat: parcels.bboxMinLat,
			bboxMinLng: parcels.bboxMinLng,
			bboxMaxLat: parcels.bboxMaxLat,
			bboxMaxLng: parcels.bboxMaxLng,
		})
		.from(parcels)
		.where(
			and(
				lte(parcels.bboxMinLat, lat),
				gte(parcels.bboxMaxLat, lat),
				lte(parcels.bboxMinLng, lng),
				gte(parcels.bboxMaxLng, lng),
			),
		)
		.limit(20);
	for (const c of candidates) {
		const ring = parseParcelRing(c.polygon);
		if (pointInRing(ring, lat, lng)) return c;
	}
	return null;
}

/** Resolve one point to a parcel id, optionally fetching it from EGiB. */
async function resolveParcel(
	lat: number,
	lng: number,
	onDemand: boolean,
): Promise<{ parcelId: string; fetched: boolean } | null> {
	const local = await findLocalParcel(lat, lng);
	if (local) return { parcelId: local.parcelId, fetched: false };
	if (!onDemand) return null;
	const remote = await fetchParcelAtPoint(lat, lng);
	if (!remote) return null;
	await storeEgibParcel(remote);
	return { parcelId: remote.parcelId, fetched: true };
}

export async function assignParcels(
	options: AssignParcelsOptions = {},
): Promise<AssignParcelsReport> {
	const listingLimit = options.listingLimit ?? 500;
	const transactionLimit = options.transactionLimit ?? 200;
	const onDemand = options.onDemand ?? true;

	const report: AssignParcelsReport = {
		listings: 0,
		transactions: 0,
		fetched: 0,
		missed: 0,
	};

	// New listings first: these are the rows the current crawl created.
	const unassignedListings = await db
		.select({
			id: listings.id,
			lat: listings.lat,
			lng: listings.lng,
		})
		.from(listings)
		.where(
			and(
				isNull(listings.parcelId),
				isNotNull(listings.lat),
				isNotNull(listings.lng),
			),
		)
		.limit(listingLimit);

	for (const row of unassignedListings) {
		if (row.lat === null || row.lng === null) continue;
		const hit = await resolveParcel(row.lat, row.lng, onDemand);
		if (!hit) {
			report.missed++;
			continue;
		}
		await db
			.update(listings)
			.set({ parcelId: hit.parcelId })
			.where(eq(listings.id, row.id));
		report.listings++;
		if (hit.fetched) report.fetched++;
	}

	const unassignedTransactions = await db
		.select({
			id: transactions.id,
			lat: transactions.lat,
			lng: transactions.lng,
		})
		.from(transactions)
		.where(
			and(
				isNull(transactions.parcelId),
				isNotNull(transactions.lat),
				isNotNull(transactions.lng),
			),
		)
		.limit(transactionLimit);

	// Group updates by parcel so the write side stays a few statements.
	const byParcel = new Map<string, number[]>();
	const flush = async () => {
		for (const [parcelId, ids] of byParcel) {
			for (let i = 0; i < ids.length; i += 400) {
				await db
					.update(transactions)
					.set({ parcelId })
					.where(inArray(transactions.id, ids.slice(i, i + 400)));
			}
		}
		byParcel.clear();
	};

	for (const row of unassignedTransactions) {
		if (row.lat === null || row.lng === null) continue;
		const hit = await resolveParcel(row.lat, row.lng, onDemand);
		if (!hit) {
			report.missed++;
			continue;
		}
		const ids = byParcel.get(hit.parcelId) ?? [];
		ids.push(row.id);
		byParcel.set(hit.parcelId, ids);
		report.transactions++;
		if (hit.fetched) report.fetched++;
		if (report.transactions % 400 === 0) await flush();
	}
	await flush();

	return report;
}

/** CLI alias for `bun run assign-parcels`. */
async function main(): Promise<void> {
	const report = await assignParcels({
		listingLimit: 50_000,
		transactionLimit: 50_000,
		onDemand: true,
	});
	console.log(
		`assign-parcels: ${report.listings} listings, ${report.transactions} transactions, ` +
			`${report.fetched} fetched from EGiB, ${report.missed} missed`,
	);
}

if (
	process.argv[1]?.replace(/\\/g, "/").endsWith("/src/crawler/parcel-index.ts")
) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
