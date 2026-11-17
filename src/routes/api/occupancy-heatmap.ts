import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { occupancyCells, parseOccupancySearch } from "#/db/queries/occupancy";

/**
 * Spatial occupancy heatmap.
 *
 * Aggregates the per-listing monthly occupancy table into lat/lng grid cells
 * so the map can show "areas with highest occupation" for short-term rentals.
 *
 * Query params:
 *   - month: YYYY-MM (defaults to current month)
 *   - source: "airbnb" | "booking" | "all" (default "all")
 *   - grid: 0.001 | 0.005 | 0.01 (degrees, default 0.005)
 */
export const Route = createFileRoute("/api/occupancy-heatmap")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const query = parseOccupancySearch(new URL(request.url));
				return json({
					...query,
					cells: await occupancyCells(query),
				});
			},
		},
	},
});
