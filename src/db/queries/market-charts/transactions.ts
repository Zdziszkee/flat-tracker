import { sql } from "drizzle-orm";

import { inTrackedRegions } from "#/db/region";
import { daysAgo, monthExpr, priceBandClause } from "#/db/sql";
import { POWIAT_NAMES } from "#/lib/powiats";
import { all } from "./shared";

/** RCN price trend by month. */
export interface PriceTrendRow {
	month: string;
	avgM2: number;
	tx: number;
}

export interface YoyRow {
	powiat: string;
	growthPct: number | null;
	recent: number | null;
	prior: number | null;
	tx: number;
}

export interface VolumeRow {
	month: string;
	tx: number;
}

export interface PrimaryVsSecondaryRow {
	powiat: string;
	wtorny: number;
	pierwotny: number;
}

export interface RoomsRow {
	label: string;
	avgM2: number;
	n: number;
}

export async function getPriceTrend(): Promise<PriceTrendRow[]> {
	return all<PriceTrendRow>(sql`
		SELECT ${monthExpr(sql`date`)} AS month,
		       avg(pricePerM2) AS avgM2,
		       count(*) AS tx
		FROM transactions
		WHERE ${inTrackedRegions} AND ${priceBandClause(sql`pricePerM2`)}
		  AND date BETWEEN ${daysAgo(365 * 3)} AND ${daysAgo(0)}
		GROUP BY month ORDER BY month
	`);
}

/**
 * Year-over-year price growth per powiat: last 12 months versus the previous
 * 12. The chart says exactly that, but the old query used a 12-year lower
 * bound, so "prior" was an 11-year average and the minimum-10-transaction
 * guard was meaningless. The window is 730 days now.
 */
export async function getYoyByPowiat(): Promise<YoyRow[]> {
	const yoyRaw = await all<{
		teryt: string;
		window: string;
		avgM2: number;
		windowTx: number;
	}>(sql`
		SELECT substr(parcel_id, 1, 4) AS teryt,
		       CASE WHEN date >= ${daysAgo(365)}
		            THEN 'recent' ELSE 'prior' END AS window,
		       avg(pricePerM2) AS avgM2,
		       count(*) AS windowTx
		FROM transactions
		WHERE ${inTrackedRegions} AND ${priceBandClause(sql`pricePerM2`)}
		  AND parcel_id IS NOT NULL
		  AND date BETWEEN ${daysAgo(730)} AND ${daysAgo(0)}
		GROUP BY teryt, window
	`);
	const recentCounts = await all<{ teryt: string; tx: number }>(sql`
		SELECT substr(parcel_id, 1, 4) AS teryt, count(*) AS tx
		FROM transactions
		WHERE ${inTrackedRegions} AND parcel_id IS NOT NULL AND date >= ${daysAgo(365)}
		GROUP BY teryt
	`);
	const txCount = new Map(recentCounts.map((row) => [row.teryt, row.tx]));
	const byPowiat = new Map<string, { recent?: number; prior?: number }>();
	const windowTx = new Map<string, number>();
	for (const row of yoyRaw) {
		const entry = byPowiat.get(row.teryt) ?? {};
		if (row.window === "recent") entry.recent = row.avgM2;
		else entry.prior = row.avgM2;
		byPowiat.set(row.teryt, entry);
		windowTx.set(`${row.teryt}:${row.window}`, row.windowTx);
	}

	const rows: YoyRow[] = [];
	for (const [teryt, entry] of byPowiat) {
		const powiat = POWIAT_NAMES[teryt];
		if (!powiat) continue;
		const recentTx = windowTx.get(`${teryt}:recent`) ?? 0;
		const priorTx = windowTx.get(`${teryt}:prior`) ?? 0;
		if (recentTx < 10 || priorTx < 10) continue;
		const growthPct =
			entry.recent != null && entry.prior != null && entry.prior > 0
				? ((entry.recent - entry.prior) / entry.prior) * 100
				: null;
		if (growthPct == null || Math.abs(growthPct) > 200) continue;
		rows.push({
			powiat,
			growthPct,
			recent: entry.recent != null ? Math.round(entry.recent) : null,
			prior: entry.prior != null ? Math.round(entry.prior) : null,
			tx: txCount.get(teryt) ?? 0,
		});
	}
	return rows.sort((a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0));
}

export async function getTxVolume(): Promise<VolumeRow[]> {
	return all<VolumeRow>(sql`
		SELECT ${monthExpr(sql`date`)} AS month, count(*) AS tx
		FROM transactions
		WHERE ${inTrackedRegions} AND date BETWEEN ${daysAgo(365 * 3)} AND ${daysAgo(0)}
		GROUP BY month ORDER BY month
	`);
}

export async function getPrimaryVsSecondary(): Promise<
	PrimaryVsSecondaryRow[]
> {
	const rows = await all<{
		teryt: string;
		market: number;
		avgM2: number;
	}>(sql`
		SELECT substr(parcel_id, 1, 4) AS teryt, market,
		       avg(pricePerM2) AS avgM2
		FROM transactions
		WHERE ${inTrackedRegions} AND ${priceBandClause(sql`pricePerM2`)}
		  AND parcel_id IS NOT NULL
		  AND market IN (1, 2)
		  AND date BETWEEN ${daysAgo(365 * 12)} AND ${daysAgo(0)}
		GROUP BY teryt, market HAVING count(*) >= 5
	`);
	const byPowiat = new Map<string, { wtorny?: number; pierwotny?: number }>();
	for (const row of rows) {
		const entry = byPowiat.get(row.teryt) ?? {};
		// RCN market codes follow the Kraków zip import: 1 = wtórny,
		// 2 = pierwotny.
		if (row.market === 1) entry.wtorny = Math.round(row.avgM2);
		else entry.pierwotny = Math.round(row.avgM2);
		byPowiat.set(row.teryt, entry);
	}
	return [...byPowiat.entries()].flatMap(([teryt, entry]) => {
		const powiat = POWIAT_NAMES[teryt];
		if (!powiat || entry.wtorny == null || entry.pierwotny == null) return [];
		return [{ powiat, wtorny: entry.wtorny, pierwotny: entry.pierwotny }];
	});
}

export async function getTxByRooms(): Promise<RoomsRow[]> {
	return all<RoomsRow>(sql`
		SELECT CASE
			WHEN rooms IS NULL OR rooms = 0 THEN 'n/d'
			WHEN rooms = 1 THEN '1 pokój'
			WHEN rooms = 2 THEN '2 pokoje'
			WHEN rooms = 3 THEN '3 pokoje'
			WHEN rooms = 4 THEN '4 pokoje'
			ELSE '5+' END AS label,
		       avg(pricePerM2) AS avgM2, count(*) AS n
		FROM transactions
		WHERE ${inTrackedRegions} AND ${priceBandClause(sql`pricePerM2`)}
		  AND rooms IS NOT NULL
		  AND date >= ${daysAgo(730)}
		GROUP BY label
		ORDER BY CASE label
			WHEN 'n/d' THEN 0 WHEN '1 pokój' THEN 1 WHEN '2 pokoje' THEN 2
			WHEN '3 pokoje' THEN 3 WHEN '4 pokoje' THEN 4 ELSE 5 END
	`);
}
