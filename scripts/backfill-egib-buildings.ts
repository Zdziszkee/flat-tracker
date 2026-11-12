/**
 * Backfill EGiB building footprint features for every parcel_features row.
 *
 * Parcels are grouped into ~1 km grid cells. One WFS building query per cell
 * is much cheaper than one query per parcel.
 *
 * Usage:
 *   bunx tsx scripts/backfill-egib-buildings.ts
 */

import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { parcelFeatures, parcels } from "../src/db/schema.ts";
import { parseParcelRing, ringAreaM2 } from "../src/crawler/egib.ts";
import {
	egibBuildingStats,
	fetchEgibBuildingsByBbox,
} from "../src/crawler/egib-buildings.ts";

const CELL = 0.05;

async function main(): Promise<void> {
	const rows = await db
		.select({
			parcelId: parcels.parcelId,
			polygon: parcels.polygon,
			bboxMinLat: parcels.bboxMinLat,
			bboxMinLng: parcels.bboxMinLng,
			bboxMaxLat: parcels.bboxMaxLat,
			bboxMaxLng: parcels.bboxMaxLng,
		})
		.from(parcels)
		.innerJoin(parcelFeatures, eq(parcelFeatures.parcelId, parcels.parcelId))
		.where(
			or(
				isNull(parcelFeatures.egibBuildingCount),
				and(
					eq(parcelFeatures.egibBuildingCount, 0),
					gt(parcelFeatures.buildingCoverage, 0.01),
				),
			),
		);

	const cells = new Map<string, typeof rows>();
	for (const row of rows) {
		const key = `${Math.floor(row.bboxMinLat / CELL)}:${Math.floor(row.bboxMinLng / CELL)}`;
		const list = cells.get(key) ?? [];
		list.push(row);
		cells.set(key, list);
	}
	console.log(`parcels ${rows.length}, cells ${cells.size}`);

	let done = 0;
	const entries = [...cells.entries()];
	for (let i = 0; i < entries.length; i += 8) {
		const batch = entries.slice(i, i + 8);
		await Promise.all(
			batch.map(async ([, group]) => {
				const minLat = Math.min(...group.map((r) => r.bboxMinLat)) - 0.001;
				const minLng = Math.min(...group.map((r) => r.bboxMinLng)) - 0.001;
				const maxLat = Math.max(...group.map((r) => r.bboxMaxLat)) + 0.001;
				const maxLng = Math.max(...group.map((r) => r.bboxMaxLng)) + 0.001;
				let buildings: Awaited<ReturnType<typeof fetchEgibBuildingsByBbox>> = [];
				try {
					buildings = await fetchEgibBuildingsByBbox(
						minLat,
						minLng,
						maxLat,
						maxLng,
					);
				} catch {
					// Leave the parcel null on a transient WFS failure.
				}
				for (const row of group) {
					const ring = parseParcelRing(row.polygon);
					if (ring.length < 3) continue;
					const stats = egibBuildingStats(ring, buildings, ringAreaM2(ring));
					await db
						.update(parcelFeatures)
						.set({
							egibBuildingCount: stats.count,
							egibBuildingAreaM2: stats.areaM2,
							egibBuildingFloorAreaM2: stats.floorAreaM2,
							egibBuildingFloors: stats.floors,
							egibBuildingResidentialRatio: stats.residentialRatio,
							egibBuildingCoverage: stats.coverage,
							updatedAt: new Date(),
						})
						.where(eq(parcelFeatures.parcelId, row.parcelId));
					done++;
				}
			}),
		);
		console.log(
			`JCODE_PROGRESS ${JSON.stringify({
				percent: Math.round(((i + batch.length) / entries.length) * 100),
				current: i + batch.length,
				total: entries.length,
				unit: "cells",
				message: `${done} parcels`,
			})}`,
		);
	}
	console.log(`done ${done} parcels`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
