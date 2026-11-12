/**
 * Backfill EGiB building features with one WFS query per parcel, run in
 * parallel. This is faster than a grid query when cells are sparse.
 *
 * Usage:
 *   bunx tsx scripts/backfill-egib-buildings-parcel.ts
 */

import { eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { parcelFeatures, parcels } from "../src/db/schema.ts";
import { parseParcelRing, ringAreaM2 } from "../src/crawler/egib.ts";
import {
	egibBuildingStats,
	fetchEgibBuildingsByBbox,
} from "../src/crawler/egib-buildings.ts";

const CONCURRENCY = 24;

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
		.innerJoin(parcelFeatures, eq(parcelFeatures.parcelId, parcels.parcelId));

	console.log(`parcels ${rows.length}`);
	let done = 0;
	for (let i = 0; i < rows.length; i += CONCURRENCY) {
		const part = rows.slice(i, i + CONCURRENCY);
		await Promise.all(
			part.map(async (row) => {
				const ring = parseParcelRing(row.polygon);
				if (ring.length < 3) return;
				let stats: ReturnType<typeof egibBuildingStats> | null = null;
				for (let attempt = 0; attempt < 2 && !stats; attempt++) {
					try {
						const buildings = await fetchEgibBuildingsByBbox(
							row.bboxMinLat,
							row.bboxMinLng,
							row.bboxMaxLat,
							row.bboxMaxLng,
						);
						stats = egibBuildingStats(ring, buildings, ringAreaM2(ring));
					} catch {
						await new Promise((resolve) => setTimeout(resolve, 250));
					}
				}
				await db
					.update(parcelFeatures)
					.set({
						egibBuildingCount: stats?.count ?? null,
						egibBuildingAreaM2: stats?.areaM2 ?? null,
						egibBuildingFloorAreaM2: stats?.floorAreaM2 ?? null,
						egibBuildingFloors: stats?.floors ?? null,
						egibBuildingResidentialRatio: stats?.residentialRatio ?? null,
						egibBuildingCoverage: stats?.coverage ?? null,
						updatedAt: new Date(),
					})
					.where(eq(parcelFeatures.parcelId, row.parcelId));
				done++;
			}),
		);
		console.log(
			`JCODE_PROGRESS ${JSON.stringify({
				percent: Math.round(((i + part.length) / rows.length) * 100),
				current: i + part.length,
				total: rows.length,
				unit: "parcels",
				message: `${done} processed`,
			})}`,
		);
	}
	console.log(`done ${done} parcels`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
