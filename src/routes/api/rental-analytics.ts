import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { availability, listings } from "#/db/schema";

/**
 * Per-listing rental analytics: occupancy, average nightly price, revenue
 * estimate and the listed-vs-realized gap, aggregated from the latest
 * availability snapshot.
 */
export const Route = createFileRoute("/api/rental-analytics")({
	server: {
		handlers: {
			GET: async () => {
				const rows = await db
					.select({
						listingId: availability.listingId,
						title: sql<string>`max(${listings.title})`,
						source: sql<string>`max(${listings.source})`,
						district: sql<string | null>`max(${listings.district})`,
						sampleDays: sql<number>`count(*)`,
						bookedNights: sql<number>`sum(case when ${availability.available} = 0 then 1 else 0 end)`,
						avgListed: sql<number | null>`avg(${availability.listedPrice})`,
						avgEffective: sql<
							number | null
						>`avg(${availability.effectiveNightlyPrice})`,
						revenue: sql<
							number | null
						>`sum(case when ${availability.available} = 0 then ${availability.effectiveNightlyPrice} else 0 end)`,
					})
					.from(availability)
					.innerJoin(listings, eq(availability.listingId, listings.id))
					.where(sql`${availability.date} >= date('now')`)
					.groupBy(availability.listingId)
					.orderBy(
						sql`sum(case when ${availability.available} = 0 then 1 else 0 end) desc`,
					)
					.all();

				return json({
					rows: rows.map((r) => ({
						...r,
						occupancy:
							r.sampleDays > 0
								? Number(((r.bookedNights / r.sampleDays) * 100).toFixed(1))
								: 0,
						priceGap:
							r.avgListed != null && r.avgEffective != null
								? Number((r.avgListed - r.avgEffective).toFixed(2))
								: null,
					})),
				});
			},
		},
	},
});
