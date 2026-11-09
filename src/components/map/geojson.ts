import type { OccupancyCell } from "#/types/occupancy";
import type { OccupancyGeoJsonFeatureCollection } from "./types";

export function occupancyToGeoJson(
	cells: OccupancyCell[],
): OccupancyGeoJsonFeatureCollection {
	return {
		type: "FeatureCollection",
		features: cells
			.filter((cell) => cell.occupancyRate != null && cell.occupancyRate > 0)
			.map((cell) => ({
				type: "Feature",
				geometry: { type: "Point", coordinates: [cell.lng, cell.lat] },
				properties: cell,
			})),
	};
}
