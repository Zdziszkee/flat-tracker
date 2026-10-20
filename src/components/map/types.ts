import type { ListingDto } from "#/types/listing";

export type ApiListing = ListingDto;

export interface BuildingLookup {
	building: {
		id: number | null;
		osmId: number;
		address: string | null;
		lat: number;
		lng: number;
		buildYear?: number | null;
		stats: {
			txCount: number;
			avgPricePerM2: number | null;
			minPricePerM2: number | null;
			maxPricePerM2: number | null;
			minPrice: number | null;
			maxPrice: number | null;
			minDate: string | null;
			maxDate: string | null;
			byYear: Array<{
				year: string;
				count: number;
				avgPricePerM2: number | null;
			}>;
			recent: Array<{
				date: string;
				price: number;
				pricePerM2: number | null;
				areaM2: number | null;
				rooms: number | null;
				street: string | null;
				streetNumber: string | null;
				district: string | null;
			}>;
		} | null;
	} | null;
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

export interface GeoJsonFeatureCollection {
	type: "FeatureCollection";
	features: Array<{
		type: "Feature";
		geometry: { type: "Point"; coordinates: number[] };
		properties: ApiListing;
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
