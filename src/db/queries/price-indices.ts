import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { priceIndices } from "#/db/schema";
import {
	chainStratifiedIndex,
	grid10Key,
	type IndexGeographyType,
	type IndexPoint,
	type PeriodObservation,
	type ValuationSegment,
} from "#/lib/valuation/price-index";

/**
 * Build quarterly, area-stratified medians and chain-linked indices from the
 * regional RCN history. The SQL returns only median rows (not the raw
 * transactions), so a multi-year rebuild does not materialize millions of
 * rows in the Node heap.
 */

const GEOGRAPHIES = ["district", "grid10", "region"] as const;
type RcnGeography = (typeof GEOGRAPHIES)[number];

interface MedianRow {
	segment: ValuationSegment;
	geoKey: string;
	period: string;
	areaBand: string;
	bandN: number;
	bandMedian: number | null;
	overallN: number;
	overallMedian: number | null;
}

const FLAT_BAND = sql`case
	when areaM2 < 35 then 'a<35'
	when areaM2 < 60 then 'b35-60'
	when areaM2 < 90 then 'c60-90'
	when areaM2 < 130 then 'd90-130'
	else 'e130+' end`;
const HOUSE_BAND = sql`case
	when areaM2 < 100 then 'a<100'
	when areaM2 < 160 then 'b100-160'
	when areaM2 < 250 then 'c160-250'
	else 'd250+' end`;
const PLOT_BAND = sql`case
	when areaM2 < 800 then 'a<800'
	when areaM2 < 2000 then 'b800-2000'
	when areaM2 < 5000 then 'c2000-5000'
	else 'd5000+' end`;

const FLAT_VALID = sql`kind = 'unit' and areaM2 between 10 and 250 and pricePerM2 between 500 and 60000`;
const HOUSE_VALID = sql`kind = 'building' and areaM2 between 20 and 2000 and pricePerM2 between 100 and 40000`;
const PLOT_VALID = sql`kind = 'parcel' and areaM2 between 50 and 100000 and pricePerM2 between 0.01 and 20000`;

function geoSql(geoType: RcnGeography) {
	if (geoType === "district") {
		return {
			key: sql`lower(trim(district))`,
			filter: sql`and district is not null and district != ''`,
		};
	}
	if (geoType === "grid10") {
		return {
			key: sql`printf('%.1f:%.1f', round(lat, 1), round(lng, 1))`,
			filter: sql`and lat is not null and lng is not null`,
		};
	}
	return { key: sql`region`, filter: sql`` };
}

async function medianRows(geoType: RcnGeography): Promise<MedianRow[]> {
	const geo = geoSql(geoType);
	const period = sql`printf('%s-Q%d', strftime('%Y', date, 'unixepoch'), (cast(strftime('%m', date, 'unixepoch') as integer) + 2) / 3)`;
	// One scan computes both the overall and per-area-band median ranks.
	// The outer query keeps only the one/two rows at each median position.
	return db.all<MedianRow>(sql`
		WITH base AS (
			SELECT kind, market, date, pricePerM2, areaM2, district, lat, lng, region
			FROM transactions
			WHERE region is not null
			  AND kind is not null
			  AND date >= unixepoch('now', '-6 years')
			  AND date <= unixepoch('now')
			  AND pricePerM2 > 0
			  AND areaM2 > 0
		), segmented AS (
			SELECT 'flat_primary' AS segment, ${period} AS period,
				${FLAT_BAND} AS areaBand, ${geo.key} AS geoKey, pricePerM2
			FROM base WHERE ${FLAT_VALID} AND market = 1 ${geo.filter}
			UNION ALL
			SELECT 'flat_secondary', ${period}, ${FLAT_BAND}, ${geo.key}, pricePerM2
			FROM base WHERE ${FLAT_VALID} AND market = 2 ${geo.filter}
			UNION ALL
			SELECT 'flat', ${period}, ${FLAT_BAND}, ${geo.key}, pricePerM2
			FROM base WHERE ${FLAT_VALID} ${geo.filter}
			UNION ALL
			SELECT 'house', ${period}, ${HOUSE_BAND}, ${geo.key}, pricePerM2
			FROM base WHERE ${HOUSE_VALID} ${geo.filter}
			UNION ALL
			SELECT 'plot', ${period}, ${PLOT_BAND}, ${geo.key}, pricePerM2
			FROM base WHERE ${PLOT_VALID} ${geo.filter}
		), ranked AS (
			SELECT segment, geoKey, period, areaBand, pricePerM2,
				count(*) OVER (PARTITION BY segment, geoKey, period) AS overallN,
				row_number() OVER (PARTITION BY segment, geoKey, period ORDER BY pricePerM2) AS overallRn,
				count(*) OVER (PARTITION BY segment, geoKey, period, areaBand) AS bandN,
				row_number() OVER (PARTITION BY segment, geoKey, period, areaBand ORDER BY pricePerM2) AS bandRn
			FROM segmented
		)
		SELECT segment, geoKey, period, areaBand, bandN,
			avg(case when bandRn in ((bandN + 1) / 2, (bandN + 2) / 2) then pricePerM2 end) AS bandMedian,
			max(overallN) AS overallN,
			avg(case when overallRn in ((overallN + 1) / 2, (overallN + 2) / 2) then pricePerM2 end) AS overallMedian
		FROM ranked
		WHERE bandRn in ((bandN + 1) / 2, (bandN + 2) / 2)
		   OR overallRn in ((overallN + 1) / 2, (overallN + 2) / 2)
		GROUP BY segment, geoKey, period, areaBand
	`);
}

function observations(rows: readonly MedianRow[]): PeriodObservation[] {
	const byPeriod = new Map<string, PeriodObservation>();
	for (const row of rows) {
		if (
			row.overallMedian == null ||
			row.overallMedian <= 0 ||
			row.overallN <= 0
		) {
			continue;
		}
		let observation = byPeriod.get(row.period);
		if (!observation) {
			observation = {
				period: row.period,
				overallMedian: row.overallMedian,
				overallCount: row.overallN,
				strata: [],
			};
			byPeriod.set(row.period, observation);
		}
		if (row.bandMedian != null && row.bandMedian > 0 && row.bandN > 0) {
			observation.strata.push({
				band: row.areaBand,
				median: row.bandMedian,
				count: row.bandN,
			});
		}
	}
	return [...byPeriod.values()];
}

export interface PriceIndexBuildReport {
	series: number;
	rows: number;
	geographies: Record<string, number>;
}

/** Rebuild all local RCN index series; external NBP rows are preserved. */
export async function rebuildPriceIndices(): Promise<PriceIndexBuildReport> {
	const values: Array<typeof priceIndices.$inferInsert> = [];
	const geographies: Record<string, number> = {};
	let series = 0;
	for (const geographyType of GEOGRAPHIES) {
		const rows = await medianRows(geographyType);
		const bySeries = new Map<string, MedianRow[]>();
		for (const row of rows) {
			const key = `${row.segment}|${row.geoKey}`;
			const list = bySeries.get(key) ?? [];
			list.push(row);
			bySeries.set(key, list);
		}
		let geographyRows = 0;
		for (const [key, seriesRows] of bySeries) {
			const [segment, geographyKey] = key.split("|");
			if (!segment || !geographyKey) continue;
			const chained = chainStratifiedIndex(observations(seriesRows));
			if (chained.length === 0) continue;
			series++;
			for (const observation of chained) {
				values.push({
					segment: segment as ValuationSegment,
					geographyType,
					geographyKey,
					period: observation.period,
					indexValue: observation.indexValue,
					medianPriceM2: observation.overallMedian,
					sampleCount: observation.overallCount,
					strata: JSON.stringify(observation.strata),
					method: "stratified_median",
					source: "rcn",
				});
				geographyRows++;
			}
		}
		geographies[geographyType] = geographyRows;
	}

	await db.delete(priceIndices).where(eq(priceIndices.source, "rcn"));
	for (let i = 0; i < values.length; i += 500) {
		await db.insert(priceIndices).values(values.slice(i, i + 500));
	}
	return { series, rows: values.length, geographies };
}

export async function priceIndexSeries(input: {
	segment: ValuationSegment;
	geographyType: IndexGeographyType;
	geographyKey: string;
	source?: string;
}): Promise<IndexPoint[]> {
	const rows = await db
		.select({
			segment: priceIndices.segment,
			geographyType: priceIndices.geographyType,
			geographyKey: priceIndices.geographyKey,
			period: priceIndices.period,
			indexValue: priceIndices.indexValue,
			medianPriceM2: priceIndices.medianPriceM2,
			sampleCount: priceIndices.sampleCount,
			source: priceIndices.source,
		})
		.from(priceIndices)
		.where(
			and(
				eq(priceIndices.segment, input.segment),
				eq(priceIndices.geographyType, input.geographyType),
				eq(priceIndices.geographyKey, input.geographyKey),
				eq(priceIndices.source, input.source ?? "rcn"),
			),
		)
		.orderBy(asc(priceIndices.period));
	return rows as IndexPoint[];
}

/** Shared key helper for callers that need the exact SQL grid format. */
export { grid10Key };
