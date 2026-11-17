import mapboxgl from "mapbox-gl";

import type { OccupancyCell } from "#/types/occupancy";
import { POPUP_CLASS } from "./chrome";
import { occupancyToGeoJson } from "./geojson";
import { occupancyPopupHtml } from "./popups";
import type { PopupRef } from "./types";

/** Short-term rental occupancy heatmap (rendered on top of the listings). */
export function addOccupancyLayer(
	map: mapboxgl.Map,
	cells: OccupancyCell[],
	visible: boolean,
	popupRef: PopupRef,
): void {
	if (map.getSource("occupancy")) return;
	map.addSource("occupancy", {
		type: "geojson",
		data: occupancyToGeoJson(cells),
	});
	map.addLayer({
		id: "occupancy-heat",
		type: "heatmap",
		source: "occupancy",
		layout: {
			visibility: visible ? "visible" : "none",
		},
		paint: {
			"heatmap-weight": [
				"interpolate",
				["linear"],
				["get", "occupancyRate"],
				0,
				0,
				100,
				1,
			],
			"heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 14, 2],
			"heatmap-color": [
				"interpolate",
				["linear"],
				["heatmap-density"],
				0,
				"rgba(0, 0, 255, 0)",
				0.2,
				"rgba(0, 255, 255, 0.4)",
				0.4,
				"rgba(0, 255, 0, 0.5)",
				0.6,
				"rgba(255, 255, 0, 0.6)",
				0.8,
				"rgba(255, 0, 0, 0.7)",
			],
			"heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 15, 14, 40],
			"heatmap-opacity": 0.75,
		},
	});

	map.on("click", "occupancy-heat", (e) => {
		const props = (e.features?.[0] as unknown as { properties?: OccupancyCell })
			?.properties;
		if (!props || props.occupancyRate == null) return;
		const rate = props.occupancyRate;
		popupRef.current?.remove();
		const popup = new mapboxgl.Popup({
			className: POPUP_CLASS,
			offset: 8,
			closeButton: false,
			maxWidth: "260px",
		})
			.setLngLat(e.lngLat)
			.setHTML(occupancyPopupHtml({ ...props, occupancyRate: rate }))
			.addTo(map);
		popupRef.current = popup;
	});
	map.on("mouseenter", "occupancy-heat", () => {
		map.getCanvas().style.cursor = "pointer";
	});
	map.on("mouseleave", "occupancy-heat", () => {
		map.getCanvas().style.cursor = "";
	});
}

/**
 * Occupancy heatmap visibility toggle. Data updates go through
 * `setOccupancyData` so flipping visibility never re-serializes the payload.
 */
export function setOccupancyVisible(map: mapboxgl.Map, visible: boolean): void {
	const layer = map.getLayer("occupancy-heat");
	if (layer) {
		map.setLayoutProperty(
			"occupancy-heat",
			"visibility",
			visible ? "visible" : "none",
		);
	}
}

/** Push a new occupancy snapshot into the heatmap source. */
export function setOccupancyData(
	map: mapboxgl.Map,
	cells: OccupancyCell[],
): void {
	const src = map.getSource("occupancy") as mapboxgl.GeoJSONSource | undefined;
	if (src && "setData" in src) {
		src.setData(occupancyToGeoJson(cells));
	}
}
