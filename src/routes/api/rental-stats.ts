import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingMonthlyPrice, listings } from "#/db/schema";

/**
 * Rental analytics: monthly price aggregations per rental listing, joined to
 * the listing metadata so the UI can render district/price-seasonality views.
 */
export const Route = createFileRoute("/api/rental-stats")({
	server: {
		handlers: {
			GET: async () => {
				const rows = await db
					.select({
						listingId: listingMonthlyPrice.listingId,
						month: listingMonthlyPrice.month,
						avgListedPrice: listingMonthlyPrice.avgListedPrice,
						avgEffectiveNightlyPrice:
							listingMonthlyPrice.avgEffectiveNightlyPrice,
						minPrice: listingMonthlyPrice.minPrice,
						maxPrice: listingMonthlyPrice.maxPrice,
						sampleDays: listingMonthlyPrice.sampleDays,
						bookedNights: listingMonthlyPrice.bookedNights,
						title: listings.title,
						source: listings.source,
						district: listings.district,
						offerType: listings.offerType,
						pricePeriod: listings.pricePeriod,
						lat: listings.lat,
						lng: listings.lng,
					})
					.from(listingMonthlyPrice)
					.innerJoin(listings, eq(listingMonthlyPrice.listingId, listings.id))
					.orderBy(sql`${listingMonthlyPrice.month} desc`);
				return json({ rows });
			},
		},
	},
});
