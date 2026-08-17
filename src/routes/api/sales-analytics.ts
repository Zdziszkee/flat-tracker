import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listings } from "#/db/schema";

/**
 * Sales analytics: overall sale-market stats plus district-level averages.
 */
export const Route = createFileRoute("/api/sales-analytics")({
	server: {
		handlers: {
			GET: async () => {
				const overall = await db
					.select({
						count: sql<number>`count(*)`,
						avgPrice: sql<number | null>`avg(${listings.price})`,
						avgPricePerM2: sql<number | null>`avg(${listings.pricePerM2})`,
						avgArea: sql<number | null>`avg(${listings.areaM2})`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.isActive} = 1`,
					)
					.get();

				const byDistrict = await db
					.select({
						district: listings.district,
						count: sql<number>`count(*)`,
						avgPrice: sql<number | null>`avg(${listings.price})`,
						avgPricePerM2: sql<number | null>`avg(${listings.pricePerM2})`,
						avgArea: sql<number | null>`avg(${listings.areaM2})`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.isActive} = 1 and ${listings.district} is not null and ${listings.district} != ''`,
					)
					.groupBy(listings.district)
					.orderBy(sql`count(*) desc`)
					.all();

				return json({ overall, byDistrict });
			},
		},
	},
});
