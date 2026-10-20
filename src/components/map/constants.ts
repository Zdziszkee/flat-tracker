import { REGIONS } from "#/crawler/regions";
import { env } from "#/env";

/**
 * Bounding box of every tracked voivodeship (Małopolska + Śląsk), unioned so
 * one view can hold both. Derived from the crawler region config, the single
 * source of truth for region boxes.
 */
export const TRACKED_REGION_BOUNDS: [[number, number], [number, number]] = [
	[
		Math.min(...REGIONS.map((r) => r.bbox.minLng)) - 0.05,
		Math.min(...REGIONS.map((r) => r.bbox.minLat)) - 0.05,
	],
	[
		Math.max(...REGIONS.map((r) => r.bbox.maxLng)) + 0.05,
		Math.max(...REGIONS.map((r) => r.bbox.maxLat)) + 0.05,
	],
];

/**
 * Default camera: the middle of that union (Olkusz/Trzebinia area), fitted to
 * the viewport on mount so both voivodeships are framed on any screen.
 */
export const TRACKED_REGION_CENTER: [number, number] = [
	(TRACKED_REGION_BOUNDS[0][0] + TRACKED_REGION_BOUNDS[1][0]) / 2,
	(TRACKED_REGION_BOUNDS[0][1] + TRACKED_REGION_BOUNDS[1][1]) / 2,
];

/**
 * Hard camera limit: the region union plus slack. `fitBounds` must fit a
 * wider-than-tall region into a landscape viewport, so it needs to zoom out
 * past the union's own width to also fit its latitude. With `maxBounds` set
 * to the union exactly, the first frame crops the north and south.
 */
export const MAP_MAX_BOUNDS: [[number, number], [number, number]] = [
	[TRACKED_REGION_BOUNDS[0][0] - 1.0, TRACKED_REGION_BOUNDS[0][1] - 0.4],
	[TRACKED_REGION_BOUNDS[1][0] + 1.0, TRACKED_REGION_BOUNDS[1][1] + 0.4],
];

/** Building shells load lazily from this zoom (sub-pixel below it). */
export const BUILDING_LAYERS_MINZOOM = 13;
/**
 * Zoom from which the basemap's 3D landmarks and trees come back on. Below
 * it the two-voivodeship overview is hundreds of models per frame.
 */
export const DETAIL_3D_MINZOOM = 12;

export const TOKEN = env.VITE_MAPBOX_TOKEN;
