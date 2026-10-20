import type { OccupancyCell } from "#/types/occupancy";
import type {
	ApiListing,
	GeoJsonFeatureCollection,
	OccupancyGeoJsonFeatureCollection,
} from "./types";

export function toGeoJson(listings: ApiListing[]): GeoJsonFeatureCollection {
	return {
		type: "FeatureCollection",
		features: listings
			.filter((listing) => listing.mapLat !== null && listing.mapLng !== null)
			.map((listing) => ({
				type: "Feature",
				geometry: {
					type: "Point",
					coordinates: [listing.mapLng as number, listing.mapLat as number],
				},
				properties: listing,
			})),
	};
}

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
