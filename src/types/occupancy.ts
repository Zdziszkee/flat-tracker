export interface OccupancyCell {
	lat: number;
	lng: number;
	listings: number;
	sampleNights: number;
	bookedNights: number;
	occupancyRate: number | null;
	avgPrice: number | null;
}

export interface OccupancyHeatmap {
	month: string;
	source: string;
	grid: number;
	cells: OccupancyCell[];
}
