import { eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingOccupancy, listings } from "#/db/schema";
import type { OccupancyCell } from "#/types/occupancy";

/**
 * Shared query layer for the two occupancy endpoints: the full heatmap
 * (`/api/occupancy-heatmap`) and the ranked top-cell table
 * (`/api/top-occupancy-areas`). They differ only in the HAVING threshold and
 * the LIMIT, so the month/source/grid parsing and the aggregation live here.
 */

/** Grid sizes (degrees) the API accepts; anything else falls back to 0.005. */
const GRID_SIZES = [0.001, 0.005, 0.01];
const DEFAULT_GRID = 0.005;

export interface OccupancyQuery {
	month: string;
	source: string;
	grid: number;
}

/** Current month in the `YYYY-MM` form the occupancy table stores. */
export function defaultOccupancyMonth(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** `month`, `source` and `grid` query params, with the same defaults/limits. */
export function parseOccupancySearch(url: URL): OccupancyQuery {
	const month = url.searchParams.get("month") ?? defaultOccupancyMonth();
	const source = url.searchParams.get("source") ?? "all";
	const gridRaw = Number(url.searchParams.get("grid") ?? String(DEFAULT_GRID));
	// Only allow a small set of sane grid sizes to avoid huge queries.
	const grid = GRID_SIZES.includes(gridRaw) ? gridRaw : DEFAULT_GRID;
	return { month, source, grid };
}

export interface OccupancyCellsOptions extends OccupancyQuery {
	/** Drop cells with fewer listings (default 1 keeps every non-empty cell). */
	minListings?: number;
	/** Optional cap on returned cells; the heatmap passes none. */
	limit?: number;
}

/**
 * Aggregate the per-listing monthly occupancy table into lat/lng grid cells,
 * ordered by average occupancy. `occupancyRate` is a percentage (0-100) and
 * `avgPrice` the average available nightly price.
 */
export async function occupancyCells({
	month,
	source,
	grid,
	minListings = 1,
	limit,
}: OccupancyCellsOptions): Promise<OccupancyCell[]> {
	const gridFactor = 1 / grid;
	const sourceFilter =
		source === "airbnb" || source === "booking"
			? eq(listings.source, source)
			: sql`1 = 1`;
	const limitClause = limit == null ? sql`` : sql`LIMIT ${limit}`;

	const rows = await db.all<{
		cellLat: number;
		cellLng: number;
		listings: number;
		sampleNights: number;
		bookedNights: number;
		avgOccupancy: number | null;
		avgAvailablePrice: number | null;
	}>(sql`
		SELECT
			cast(round(${listings.lat} * ${gridFactor}) / ${gridFactor} as real) AS cellLat,
			cast(round(${listings.lng} * ${gridFactor}) / ${gridFactor} as real) AS cellLng,
			count(DISTINCT ${listingOccupancy.listingId}) AS listings,
			sum(${listingOccupancy.sampleDays}) AS sampleNights,
			sum(${listingOccupancy.bookedNights}) AS bookedNights,
			avg(${listingOccupancy.occupancyRate}) AS avgOccupancy,
			avg(${listingOccupancy.avgAvailablePrice}) AS avgAvailablePrice
		FROM ${listingOccupancy}
		INNER JOIN ${listings}
			ON ${listingOccupancy.listingId} = ${listings.id}
		WHERE ${listingOccupancy.month} = ${month}
		  AND ${listings.lat} IS NOT NULL
		  AND ${listings.lng} IS NOT NULL
		  AND ${sourceFilter}
		GROUP BY cellLat, cellLng
		HAVING listings >= ${minListings}
		ORDER BY avgOccupancy DESC NULLS LAST
		${limitClause}
	`);

	return rows.map((r) => ({
		lat: r.cellLat,
		lng: r.cellLng,
		listings: r.listings,
		sampleNights: r.sampleNights,
		bookedNights: r.bookedNights,
		occupancyRate:
			r.avgOccupancy != null ? Number((r.avgOccupancy * 100).toFixed(1)) : null,
		avgPrice: r.avgAvailablePrice
			? Number(r.avgAvailablePrice.toFixed(2))
			: null,
	}));
}
