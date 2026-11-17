import type { Popup } from "mapbox-gl";
import type { ListingDto, MapFeedPoint } from "#/types/listing";

export type ApiListing = ListingDto;

/**
 * Mutable handle to the single open popup. The layer modules replace the
 * previous popup before opening their own, so only one is on screen.
 */
export interface PopupRef {
	current: Popup | null;
}

/** Viewport-limited parcel grid from /api/parcels. */
export interface ParcelFeatureCollection {
	type: "FeatureCollection";
	features: Array<{
		type: "Feature";
		geometry: { type: "Polygon"; coordinates: number[][][] };
		properties: {
			parcelId: string;
			hasRcn: boolean;
			obreb?: string | null;
			gmina?: string | null;
		};
	}>;
}

/** Viewport feed from `/api/listings?view=map`: clusters or compact points. */
export interface MapFeedFeatureCollection {
	type: "FeatureCollection";
	features: Array<{
		type: "Feature";
		geometry: { type: "Point"; coordinates: [number, number] };
		properties: MapFeedPoint;
	}>;
}

export interface OccupancyGeoJsonFeatureCollection {
	type: "FeatureCollection";
	features: Array<{
		type: "Feature";
		geometry: { type: "Point"; coordinates: number[] };
		properties: import("#/types/occupancy").OccupancyCell;
	}>;
}
