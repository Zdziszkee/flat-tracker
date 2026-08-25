import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingMonthlyPrice, listings } from "#/db/schema";

/**
 * Unified investment analytics: sales price/m2 and long-term rent/m2 by
 * district (gross yield), plus short-term rental price trends by month and
 * source.
 */
export const Route = createFileRoute("/api/investment-analytics")({
	server: {
		handlers: {
			GET: async () => {
				const salesByDistrict = await db
					.select({
						district: listings.district,
						avgPriceM2: sql<number | null>`avg(${listings.pricePerM2})`,
						count: sql<number>`count(*)`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.pricePerM2} is not null and ${listings.areaM2} between 10 and 200 and ${listings.district} is not null and ${listings.district} != ''`,
					)
					.groupBy(listings.district)
					.all();

				const rentByDistrict = await db
					.select({
						district: listings.district,
						avgRentM2: sql<
							number | null
						>`avg(${listings.price} / ${listings.areaM2})`,
						count: sql<number>`count(*)`,
					})
					.from(listings)
					.where(
						sql`${listings.source} = 'olx-rent' and ${listings.price} is not null and ${listings.areaM2} between 10 and 200 and ${listings.district} is not null and ${listings.district} != ''`,
					)
					.groupBy(listings.district)
					.all();

				const saleMap = new Map(salesByDistrict.map((r) => [r.district, r]));
				const yieldByDistrict = rentByDistrict
					.flatMap((r) => {
						if (!r.district) return [];
						const sale = saleMap.get(r.district);
						if (!sale) return [];
						const monthlyRentM2 = r.avgRentM2 ?? 0;
						const saleM2 = sale.avgPriceM2 ?? 0;
						const yieldPct =
							saleM2 > 0 ? ((monthlyRentM2 * 12) / saleM2) * 100 : null;
						return [
							{
								district: r.district,
								yieldPct: yieldPct != null ? Number(yieldPct.toFixed(1)) : null,
								saleAvgM2: Number((sale.avgPriceM2 ?? 0).toFixed(0)),
								rentAvgM2: Number((monthlyRentM2 ?? 0).toFixed(0)),
								saleCount: sale.count,
								rentCount: r.count,
							},
						];
					})
					.sort((a, b) => (b.yieldPct ?? 0) - (a.yieldPct ?? 0));

				const monthlyTrend = await db
					.select({
						month: listingMonthlyPrice.month,
						avgNightly: sql<
							number | null
						>`avg(${listingMonthlyPrice.avgEffectiveNightlyPrice})`,
						count: sql<number>`count(*)`,
					})
					.from(listingMonthlyPrice)
					.groupBy(listingMonthlyPrice.month)
					.orderBy(sql`${listingMonthlyPrice.month} asc`)
					.all();

				const bySource = await db
					.select({
						source: listings.source,
						avgNightly: sql<number | null>`avg(${listings.price})`,
						count: sql<number>`count(*)`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} in ('short_term_rental','long_term_rental') and ${listings.price} is not null`,
					)
					.groupBy(listings.source)
					.all();

				return json({
					salesByDistrict,
					yieldByDistrict,
					monthlyTrend,
					bySource,
				});
			},
		},
	},
});
