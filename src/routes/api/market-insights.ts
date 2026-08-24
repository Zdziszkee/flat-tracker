import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import {
	listingHistory,
	listingMonthlyPrice,
	listings,
	transactions,
} from "#/db/schema";

/**
 * Market insights: the metrics an investor actually needs on top of the
 * valuation table — market composition (rooms, price histogram), price-drop
 * activity, short-term rental occupancy by district, and the RCN transacted
 * ground truth (primary vs secondary, yearly trend) against current asking
 * prices.
 */
export const Route = createFileRoute("/api/market-insights")({
	server: {
		handlers: {
			GET: async () => {
				// --- summary: asking side ---
				const saleStats = await db
					.select({
						count: sql<number>`count(*)`,
						avgM2: sql<number | null>`avg(${listings.pricePerM2})`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.isActive} = 1 and ${listings.pricePerM2} is not null`,
					)
					.get();

				const rentStats = await db
					.select({
						count: sql<number>`count(*)`,
						avgM2: sql<number | null>`avg(${listings.pricePerM2})`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'long_term_rental' and ${listings.isActive} = 1 and ${listings.pricePerM2} is not null`,
					)
					.get();

				// --- RCN transacted ground truth (apartments only) ---
				const rcnRecent = await db
					.select({
						count: sql<number>`count(*)`,
						avgM2: sql<number | null>`avg(${transactions.pricePerM2})`,
					})
					.from(transactions)
					.where(
						sql`${transactions.pricePerM2} is not null and ${transactions.date} >= strftime('%s','now','-2 years')`,
					)
					.get();

				const rcnByMarket = await db
					.select({
						market: transactions.market,
						avgM2: sql<number | null>`avg(${transactions.pricePerM2})`,
						count: sql<number>`count(*)`,
					})
					.from(transactions)
					.where(
						sql`${transactions.pricePerM2} is not null and ${transactions.market} is not null and ${transactions.date} >= strftime('%s','now','-2 years')`,
					)
					.groupBy(transactions.market)
					.all()
					.map((r) => ({
						market: r.market === 1 ? "primary" : "secondary",
						avgM2: r.avgM2 != null ? Number(r.avgM2.toFixed(0)) : null,
						count: r.count,
					}));

				const rcnYearly = await db
					.select({
						year: sql<number>`cast(strftime('%Y', ${transactions.date}, 'unixepoch') as int)`,
						avgM2: sql<number | null>`avg(${transactions.pricePerM2})`,
						count: sql<number>`count(*)`,
					})
					.from(transactions)
					.where(
						sql`${transactions.pricePerM2} is not null and ${transactions.date} >= strftime('%s','now','-8 years')`,
					)
					.groupBy(sql`strftime('%Y', ${transactions.date}, 'unixepoch')`)
					.orderBy(sql`strftime('%Y', ${transactions.date}, 'unixepoch') asc`)
					.all()
					.map((r) => ({
						year: r.year,
						avgM2: r.avgM2 != null ? Number(r.avgM2.toFixed(0)) : null,
						count: r.count,
					}));

				// --- sale asking price by rooms ---
				const priceByRooms = await db
					.select({
						rooms: listings.rooms,
						avgM2: sql<number | null>`avg(${listings.pricePerM2})`,
						avgPrice: sql<number | null>`avg(${listings.price})`,
						count: sql<number>`count(*)`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.isActive} = 1 and ${listings.rooms} is not null and ${listings.pricePerM2} is not null`,
					)
					.groupBy(listings.rooms)
					.orderBy(listings.rooms)
					.all()
					.map((r) => ({
						rooms: r.rooms,
						label: r.rooms != null && r.rooms >= 5 ? "5+" : String(r.rooms),
						avgM2: r.avgM2 != null ? Number(r.avgM2.toFixed(0)) : null,
						avgPrice: r.avgPrice != null ? Number(r.avgPrice.toFixed(0)) : null,
						count: r.count,
					}))
					.reduce<
						Array<{
							label: string;
							avgM2: number | null;
							avgPrice: number | null;
							count: number;
						}>
					>((acc, r) => {
						const last = acc[acc.length - 1];
						if (last && last.label === r.label) {
							const total = last.count + r.count;
							last.avgM2 =
								last.avgM2 != null && r.avgM2 != null
									? Number(
											(
												(last.avgM2 * last.count + r.avgM2 * r.count) /
												total
											).toFixed(0),
										)
									: (last.avgM2 ?? r.avgM2);
							last.count = total;
						} else {
							acc.push({
								label: r.label,
								avgM2: r.avgM2,
								avgPrice: r.avgPrice,
								count: r.count,
							});
						}
						return acc;
					}, []);

				// --- sale asking price/m2 histogram (2k buckets) ---
				const histogram = await db
					.select({
						bucket: sql<number>`floor(${listings.pricePerM2} / 2000) * 2000`,
						count: sql<number>`count(*)`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.isActive} = 1 and ${listings.pricePerM2} is not null and ${listings.pricePerM2} > 0 and ${listings.pricePerM2} < 40000`,
					)
					.groupBy(sql`floor(${listings.pricePerM2} / 2000) * 2000`)
					.orderBy(sql`floor(${listings.pricePerM2} / 2000) * 2000`)
					.all()
					.map((r) => ({
						label: `${Math.round(r.bucket / 1000)}-${Math.round((r.bucket + 2000) / 1000)}k`,
						count: r.count,
					}));

				// --- price drops from listing_history ---
				const history = await db
					.select({
						listingId: listingHistory.listingId,
						capturedAt: listingHistory.capturedAt,
						price: listingHistory.price,
					})
					.from(listingHistory)
					.orderBy(listingHistory.listingId, listingHistory.capturedAt)
					.all();
				let droppedCount = 0;
				let totalDropPct = 0;
				const byListing = new Map<number, number[]>();
				for (const h of history) {
					const prices = byListing.get(h.listingId) ?? [];
					if (h.price != null) prices.push(h.price);
					byListing.set(h.listingId, prices);
				}
				for (const prices of byListing.values()) {
					for (let i = 1; i < prices.length; i++) {
						if (prices[i] < prices[i - 1]) {
							droppedCount++;
							totalDropPct +=
								((prices[i - 1] - prices[i]) / prices[i - 1]) * 100;
						}
					}
				}
				const priceDrops = {
					droppedCount,
					avgDropPct:
						droppedCount > 0
							? Number((totalDropPct / droppedCount).toFixed(1))
							: null,
				};

				// --- short-term rental occupancy seasonality by month ---
				const occ = await db
					.select({
						month: listingMonthlyPrice.month,
						bookedNights: sql<number>`sum(${listingMonthlyPrice.bookedNights})`,
						sampleDays: sql<number>`sum(${listingMonthlyPrice.sampleDays})`,
					})
					.from(listingMonthlyPrice)
					.groupBy(listingMonthlyPrice.month)
					.orderBy(sql`${listingMonthlyPrice.month} asc`)
					.all()
					.map((r) => ({
						month: r.month,
						occupancyPct:
							r.sampleDays > 0
								? Number(((r.bookedNights / r.sampleDays) * 100).toFixed(1))
								: 0,
					}));

				return json({
					summary: {
						saleCount: saleStats?.count ?? 0,
						saleAvgM2:
							saleStats?.avgM2 != null
								? Number(saleStats.avgM2.toFixed(0))
								: null,
						rentCount: rentStats?.count ?? 0,
						rentAvgM2:
							rentStats?.avgM2 != null
								? Number(rentStats.avgM2.toFixed(0))
								: null,
						rcnTxCount: rcnRecent?.count ?? 0,
						rcnAvgM2:
							rcnRecent?.avgM2 != null
								? Number(rcnRecent.avgM2.toFixed(0))
								: null,
						gapPct:
							saleStats?.avgM2 != null &&
							rcnRecent?.avgM2 != null &&
							rcnRecent.avgM2 > 0
								? Number(
										(
											((saleStats.avgM2 - rcnRecent.avgM2) / rcnRecent.avgM2) *
											100
										).toFixed(1),
									)
								: null,
					},
					priceByRooms,
					priceHistogram: histogram,
					priceDrops,
					occupancyByMonth: occ,
					rcnByMarket,
					rcnYearly,
				});
			},
		},
	},
});
