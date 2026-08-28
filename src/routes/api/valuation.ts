import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listings } from "#/db/schema";

/**
 * Buy/over-under-valuation model. Compares each district's sale price per m²
 * against an income-based fair value (monthly rent/m² capitalized at a 5%
 * gross yield) and derives the key investment-decision metrics.
 */
/** Minimum offers on each side for a district to enter the ranking. */
const MIN_OFFERS = 3;

export const Route = createFileRoute("/api/valuation")({
	server: {
		handlers: {
			GET: async () => {
				const sales = await db
					.select({
						district: listings.district,
						saleAvgM2: sql<number | null>`avg(${listings.pricePerM2})`,
						count: sql<number>`count(*)`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.pricePerM2} is not null and ${listings.areaM2} between 10 and 200 and ${listings.district} is not null and ${listings.district} != ''`,
					)
					.groupBy(listings.district)
					.all();

				const rents = await db
					.select({
						district: listings.district,
						rentAvgM2: sql<
							number | null
						>`avg(${listings.price} / ${listings.areaM2})`,
						count: sql<number>`count(*)`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'long_term_rental' and ${listings.price} is not null and ${listings.areaM2} between 10 and 200 and ${listings.district} is not null and ${listings.district} != ''`,
					)
					.groupBy(listings.district)
					.all();

				const saleMap = new Map(sales.map((r) => [r.district, r]));
				const rows = rents
					.flatMap((r) => {
						if (!r.district) return [];
						const sale = saleMap.get(r.district);
						if (!sale || sale.saleAvgM2 == null || r.rentAvgM2 == null)
							return [];
						const saleM2 = sale.saleAvgM2;
						const rentM2 = r.rentAvgM2;
						const annualRentM2 = rentM2 * 12;
						const grossYieldPct = (annualRentM2 / saleM2) * 100;
						const fairPriceM2 = annualRentM2 / 0.05;
						const overUnderPct = ((saleM2 - fairPriceM2) / fairPriceM2) * 100;
						const paybackYears = saleM2 / annualRentM2;
						const priceToRent = saleM2 / annualRentM2;
						const appreciation = saleM2 * (1.03 ** 10 - 1);
						const tenYearReturnPct =
							((annualRentM2 * 10 + appreciation) / saleM2) * 100;
						// Higher = cheaper relative to income (more undervalued).
						const valueScore = Number((100 - overUnderPct).toFixed(1));
						return [
							{
								district: r.district,
								saleAvgM2: Number(saleM2.toFixed(0)),
								rentAvgM2: Number(rentM2.toFixed(1)),
								grossYieldPct: Number(grossYieldPct.toFixed(1)),
								fairPriceM2: Number(fairPriceM2.toFixed(0)),
								overUnderPct: Number(overUnderPct.toFixed(1)),
								paybackYears: Number(paybackYears.toFixed(1)),
								priceToRent: Number(priceToRent.toFixed(1)),
								tenYearReturnPct: Number(tenYearReturnPct.toFixed(1)),
								valueScore,
								saleCount: sale.count,
								rentCount: r.count,
							},
						];
					})
					.sort((a, b) => b.valueScore - a.valueScore);

				// Districts resting on <3 offers produce wild yields (a single
				// luxury flat can look "43% undervalued"); keep the ranking
				// statistically meaningful and expose counts in the UI.
				const qualified = rows.filter(
					(r) => r.saleCount >= MIN_OFFERS && r.rentCount >= MIN_OFFERS,
				);

				return json({ rows: qualified.slice(0, 15) });
			},
		},
	},
});
