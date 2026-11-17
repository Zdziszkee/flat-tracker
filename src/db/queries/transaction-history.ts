import { and, desc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { buildings, transactions } from "#/db/schema";
import { dateExpr, yearExpr } from "#/db/sql";
import type {
	BuildingTransactionSummary,
	TransactionHistory,
} from "#/types/transactions";

export type {
	BuildingTransactionSummary,
	TransactionHistory,
	TransactionHistoryRow,
	TransactionHistoryYear,
} from "#/types/transactions";

/**
 * The aggregate/byYear/recent block that the building and parcel lookups both
 * render. The shape lives in `src/types/transactions.ts` (shared with the
 * client); only the query itself belongs here.
 */

export async function transactionHistory(
	where: SQL,
): Promise<TransactionHistory> {
	const [agg] = await db
		.select({
			txCount: sql<number>`count(*)`,
			avgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
			minPricePerM2: sql<number | null>`min(${transactions.pricePerM2})`,
			maxPricePerM2: sql<number | null>`max(${transactions.pricePerM2})`,
			minPrice: sql<number | null>`min(${transactions.price})`,
			maxPrice: sql<number | null>`max(${transactions.price})`,
			minDate: sql<
				string | null
			>`strftime('%Y-%m-%d', min(${transactions.date}), 'unixepoch')`,
			maxDate: sql<
				string | null
			>`strftime('%Y-%m-%d', max(${transactions.date}), 'unixepoch')`,
		})
		.from(transactions)
		.where(where);

	const byYear = await db
		.select({
			year: yearExpr(sql`${transactions.date}`),
			count: sql<number>`count(*)`,
			avgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
		})
		.from(transactions)
		.where(where)
		.groupBy(yearExpr(sql`${transactions.date}`))
		.orderBy(sql`1`);

	const recent = await db
		.select({
			date: dateExpr(sql`${transactions.date}`),
			price: transactions.price,
			pricePerM2: transactions.pricePerM2,
			areaM2: transactions.areaM2,
			rooms: transactions.rooms,
			street: transactions.street,
			streetNumber: transactions.streetNumber,
			district: transactions.district,
		})
		.from(transactions)
		.where(where)
		.orderBy(desc(transactions.date))
		.limit(5);

	return {
		txCount: agg?.txCount ?? 0,
		avgPricePerM2: agg?.avgPricePerM2 ?? null,
		minPricePerM2: agg?.minPricePerM2 ?? null,
		maxPricePerM2: agg?.maxPricePerM2 ?? null,
		minPrice: agg?.minPrice ?? null,
		maxPrice: agg?.maxPrice ?? null,
		minDate: agg?.minDate ?? null,
		maxDate: agg?.maxDate ?? null,
		byYear: byYear.map((row) => ({
			year: String(row.year),
			count: row.count,
			avgPricePerM2: row.avgPricePerM2,
		})),
		recent: recent.map((row) => ({
			...row,
			date: String(row.date),
		})),
	};
}

export function transactionHistoryByBuilding(
	buildingId: number,
): Promise<TransactionHistory> {
	return transactionHistory(eq(transactions.buildingId, buildingId));
}

export function transactionHistoryByParcel(
	parcelId: string,
): Promise<TransactionHistory> {
	return transactionHistory(eq(transactions.parcelId, parcelId));
}

/**
 * One grouped row per building for `/api/listings`. Only the buildings the
 * surviving rows reference are queried; a region-wide GROUP BY was pure
 * overhead for a value the caller reads per listing.
 */
export function transactionSummaryByBuilding(
	buildingIds: number[],
): Promise<BuildingTransactionSummary[]> {
	if (buildingIds.length === 0) return Promise.resolve([]);
	return db
		.select({
			buildingId: transactions.buildingId,
			address: buildings.address,
			txCount: sql<number>`count(${transactions.id})`,
			txAvgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
			txMinDate: sql<
				string | null
			>`strftime('%Y-%m-%d', min(${transactions.date}), 'unixepoch')`,
			txMaxDate: sql<
				string | null
			>`strftime('%Y-%m-%d', max(${transactions.date}), 'unixepoch')`,
		})
		.from(transactions)
		.innerJoin(buildings, eq(transactions.buildingId, buildings.id))
		.where(
			and(
				inArray(transactions.buildingId, buildingIds),
				isNotNull(transactions.lat),
			),
		)
		.groupBy(transactions.buildingId);
}
