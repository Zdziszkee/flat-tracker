import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { occupancyCells, parseOccupancySearch } from "#/db/queries/occupancy";

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
				const query = parseOccupancySearch(url);
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
				return json({
					...query,
					cells: await occupancyCells({ ...query, limit, minListings }),
				});
			},
		},
	},
});
