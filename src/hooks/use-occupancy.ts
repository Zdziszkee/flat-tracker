import { useQuery } from "@tanstack/react-query";

import type { OccupancyHeatmap } from "#/types/occupancy";

/** Occupancy grid for the map overlay; disabled until the layer is on. */
export function useOccupancy(
	source: "airbnb" | "booking" | "all",
	month: string,
	enabled: boolean,
) {
	return useQuery<OccupancyHeatmap>({
		queryKey: ["occupancy-heatmap", source, month],
		queryFn: () =>
			fetch(`/api/occupancy-heatmap?source=${source}&month=${month}`).then(
				(r) => r.json(),
			),
		enabled,
		staleTime: 5 * 60_000,
	});
}
