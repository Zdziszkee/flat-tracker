import type { Map as MapboxMap } from "mapbox-gl";

/**
 * Flat-camera viewport bbox with padding, as
 * `[minLng, minLat, maxLng, maxLat]`.
 *
 * `map.getBounds()` shrinks to the ground footprint of the frustum when
 * terrain is enabled; in hilly terrain (Podhale, Beskidy) that is a sliver
 * tens of meters tall, which emptied the parcel grid and silently dropped
 * listing pins from tilted views. Both feeds therefore derive their bbox from
 * the camera centre, zoom and canvas size instead.
 */
export function flatViewportBbox(
	map: MapboxMap,
	padding = 0.1,
): [number, number, number, number] {
	const center = map.getCenter();
	const zoom = map.getZoom();
	const canvas = map.getCanvas();
	const width = canvas.clientWidth || canvas.width || 1200;
	const height = canvas.clientHeight || canvas.height || 800;
	const worldSpan = 360 / 2 ** zoom;
	const spanLng = worldSpan * (width / 512);
	const spanLat =
		(spanLng * (height / width)) /
		Math.max(0.3, Math.cos((center.lat * Math.PI) / 180));
	const padLng = spanLng * padding;
	const padLat = spanLat * padding;
	return [
		center.lng - spanLng / 2 - padLng,
		center.lat - spanLat / 2 - padLat,
		center.lng + spanLng / 2 + padLng,
		center.lat + spanLat / 2 + padLat,
	];
}
