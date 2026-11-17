import type { Map as MapboxMap } from "mapbox-gl";

import { apiUrl } from "./url";

const RAILWAY_LAYER_IDS = [
	"railway-line-casing",
	"railway-line",
	"railway-station",
	"railway-station-label",
];

/**
 * Railways + stations overlay (generated src/data/region-railways.ts, see
 * /api/railways). The basemap draws rails as faint grey; users asked for them
 * to READ: dark casing under a light slate line, stations as near-white dots
 * with names (inverted for the dusk basemap). One mixed source, layers split
 * by geometry type; under the listings so pins stay clickable.
 */
export function addRailwayLayers(map: MapboxMap): void {
	if (map.getSource("railways")) return;
	map.addSource("railways", {
		type: "geojson",
		data: apiUrl("/api/railways"),
	});
	map.addLayer({
		id: "railway-line-casing",
		type: "line",
		source: "railways",
		filter: ["==", ["geometry-type"], "LineString"],
		paint: {
			"line-color": "#0f172a",
			"line-opacity": 0.85,
			"line-width": ["interpolate", ["linear"], ["zoom"], 8, 3, 18, 12],
		},
	});
	map.addLayer({
		id: "railway-line",
		type: "line",
		source: "railways",
		filter: ["==", ["geometry-type"], "LineString"],
		paint: {
			"line-color": "#cbd5e1",
			"line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 18, 8],
		},
	});
	map.addLayer({
		id: "railway-station",
		type: "circle",
		source: "railways",
		filter: ["==", ["geometry-type"], "Point"],
		paint: {
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 3.5, 16, 7],
			"circle-color": "#e2e8f0",
			"circle-stroke-color": "#0f172a",
			"circle-stroke-width": 1.5,
		},
	});
	map.addLayer({
		id: "railway-station-label",
		type: "symbol",
		source: "railways",
		minzoom: 10,
		filter: ["==", ["geometry-type"], "Point"],
		layout: {
			"text-field": ["get", "name"],
			"text-size": 11,
			"text-offset": [0, 0.9],
			"text-anchor": "top",
			"text-allow-overlap": false,
		},
		paint: {
			"text-color": "#e2e8f0",
			"text-halo-color": "#0f172a",
			"text-halo-width": 1.5,
		},
	});
}

/** "Kolej" visibility toggle (lines + stations; data is static). */
export function setRailwaysVisible(map: MapboxMap, visible: boolean): void {
	for (const id of RAILWAY_LAYER_IDS) {
		if (map.getLayer(id)) {
			map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
		}
	}
}
