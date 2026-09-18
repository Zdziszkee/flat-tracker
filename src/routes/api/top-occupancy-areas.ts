import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingOccupancy, listings } from "#/db/schema";

/**
 * Ranked list of the highest-occupancy short-term-rental areas.
 *
 * Returns the top grid cells by average occupancy rate, so callers can build
 * a "hottest STR neighborhoods" table or highlight them on the map.
 *
 * Query params:
 *   - month: YYYY-MM (defaults to current month)
 *   - source: "airbnb" | "booking" | "all" (default "all")
 *   - grid: 0.001 | 0.005 | 0.01 (degrees, default 0.005)
 *   - limit: number of cells to return (default 50, max 200)
 *   - minListings: only cells with at least this many listings (default 1)
 */
export const Route = createFileRoute("/api/top-occupancy-areas")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const now = new Date();
				const defaultMonth = `${now.getFullYear()}-${String(
					now.getMonth() + 1,
				).padStart(2, "0")}`;
				const month = url.searchParams.get("month") ?? defaultMonth;
				const source = url.searchParams.get("source") ?? "all";
				const gridRaw = Number(url.searchParams.get("grid") ?? "0.005");
				const grid = [0.001, 0.005, 0.01].includes(gridRaw) ? gridRaw : 0.005;
				const limitRaw = Number(url.searchParams.get("limit") ?? "50");
				const limit = Math.min(
					200,
					Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50),
				);
				const minListingsRaw = Number(
					url.searchParams.get("minListings") ?? "1",
				);
				const minListings = Math.max(
					1,
					Number.isFinite(minListingsRaw) ? minListingsRaw : 1,
				);
				const gridFactor = 1 / grid;

				const sourceFilter =
					source === "airbnb" || source === "booking"
						? eq(listings.source, source)
						: sql`1 = 1`;

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
						LIMIT ${limit}
					`);

				return json({
					month,
					source,
					grid,
					cells: rows.map((r) => ({
						lat: r.cellLat,
						lng: r.cellLng,
						listings: r.listings,
						sampleNights: r.sampleNights,
						bookedNights: r.bookedNights,
						occupancyRate:
							r.avgOccupancy != null
								? Number((r.avgOccupancy * 100).toFixed(1))
								: null,
						avgPrice: r.avgAvailablePrice
							? Number(r.avgAvailablePrice.toFixed(2))
							: null,
					})),
				});
			},
		},
	},
});
