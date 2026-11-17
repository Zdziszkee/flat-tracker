import mapboxgl from "mapbox-gl";

import type { BuildingLookup } from "#/types/transactions";
import { POPUP_CLASS } from "./chrome";
import { BUILDING_LAYERS_MINZOOM } from "./constants";
import { buildingPopupHtml } from "./popups";
import type { PopupRef } from "./types";
import { apiUrl } from "./url";

/** Minimum zoom for the address label source (an unbounded dump was 38 MB). */
const LABEL_MIN_ZOOM = 15.2;

interface ClickedBuildingFeature {
	geometry?: { type: string; coordinates?: number[][][][] };
	id?: number;
}

/**
 * Click a 3D building to see its RCN price history. A listing marker under
 * the cursor wins; for fill-extrusions `e.lngLat` is the ground point, so the
 * clicked feature's own geometry supplies the coordinates.
 */
function showBuildingHistory(
	map: mapboxgl.Map,
	event: mapboxgl.MapLayerMouseEvent,
	popupRef: PopupRef,
): void {
	// If a listing marker is under the cursor, the listing popup wins.
	if (
		map.queryRenderedFeatures(event.point, {
			layers: [
				"listings-circle",
				"listings-cluster",
				"listings-cluster-count",
				"komornik-listings",
			],
		}).length > 0
	) {
		return;
	}
	const feature = map.queryRenderedFeatures(event.point, {
		layers: ["3d-building"],
	})[0] as ClickedBuildingFeature | undefined;
	if (!feature) return;
	// Prefer the feature's OSM id; coordinates are a fallback.
	const osmId = typeof feature.id === "number" ? feature.id : undefined;
	const geom = feature.geometry as
		| { type: "Polygon"; coordinates: number[][][] }
		| undefined;
	const coords = geom?.coordinates?.[0]?.[0];
	const lat = coords?.[1];
	const lng = coords?.[0];
	if (
		osmId === undefined &&
		(typeof lat !== "number" || typeof lng !== "number")
	) {
		return;
	}
	const params = new URLSearchParams();
	if (osmId !== undefined) params.set("osmId", String(osmId));
	if (typeof lat === "number" && typeof lng === "number") {
		params.set("lat", String(lat));
		params.set("lng", String(lng));
	}

	void fetch(`/api/buildings/lookup?${params.toString()}`)
		.then((r) => r.json())
		.then((data: BuildingLookup) => {
			popupRef.current?.remove();
			const popup = new mapboxgl.Popup({
				className: POPUP_CLASS,
				offset: 16,
				closeButton: false,
				maxWidth: "340px",
			})
				.setLngLat(event.lngLat)
				.setHTML(buildingPopupHtml(data))
				.addTo(map);
			popupRef.current = popup;
		})
		.catch(() => {
			// Ignore fetch errors; the map stays usable.
		});
}

/**
 * RCN history as OUR OWN fill-extrusion layer (amber) plus the address label
 * layer, created lazily once the camera is close enough.
 *
 * The Standard style's `highlight` feature-state is unusable here: per
 * Mapbox docs the select/highlight coloring "does not work for buildings
 * represented as 3D models" — it paints only the flat ground footprint while
 * the extruded model stays gray. Buildings are also the heaviest thing on the
 * map (~64 MB of footprints after server-side simplification), hence the
 * zoom gate.
 */
export function addBuildingLayersWhenZoomed(
	map: mapboxgl.Map,
	popupRef: PopupRef,
): void {
	// Mapbox Standard exposes each basemap building's REAL height
	// (props.height) keyed by OSM id; our OSM-tag estimates default to 12 m
	// when tags are missing, so tall blocks would show uncolored gray tops
	// poking through the shell. Copy real heights into per-feature states
	// whenever the viewport changes.
	//
	// Our features carry the OSM id as their GeoJSON `id` (see
	// /api/buildings/geojson), so the basemap's OSM id keys the state
	// directly; ids outside the source are a silent no-op.
	//
	// Queue + self-healing retry: a target-featureset query can throw while
	// the basemap import is still resolving; leaving the queue armed makes
	// the next idle (and there are many) finish the job.
	let amberSyncQueued = false;
	map.on("idle", () => {
		try {
			if (!amberSyncQueued || !map.getSource("buildings-rcn")) return;
			if (!map.isStyleLoaded()) return;
			const query = map.queryRenderedFeatures as unknown as (
				this: mapboxgl.Map,
				g: undefined,
				o: { target: { featuresetId: string; importId?: string } },
			) => Array<{ id?: number; properties?: { height?: number } }>;
			// Detached calls lose `this` ("reading 'style'") — bind it.
			const blds = query.call(map, undefined, {
				target: { featuresetId: "buildings", importId: "basemap" },
			});
			for (const b of blds) {
				const h = b.properties?.height;
				if (typeof b.id !== "number" || typeof h !== "number" || h <= 0) {
					continue;
				}
				map.setFeatureState(
					{ source: "buildings-rcn", id: b.id },
					{ baseHeight: h },
				);
			}
			amberSyncQueued = false;
		} catch {
			// Style/import not ready — the queue stays armed so the next
			// idle retries.
		}
	});
	map.on("moveend", () => {
		amberSyncQueued = true;
	});

	const addBuildingLayers = () => {
		if (map.getLayer("3d-building")) return;
		// URL-based GeoJSON source on purpose: mapbox's web worker does the
		// fetch + JSON.parse, so the multi-MB response never touches the UI
		// thread (an inline `data` object gets JSON.stringify'd on the main
		// thread first and blocked the map). Server-side, the route expands
		// each ring ~2% about its centroid — the Standard style extrudes the
		// SAME OSM footprints, so identical walls z-fight/interleave
		// (stripes), and the expanded shell encloses the basemap volume —
		// and keys every feature by OSM id (used by the feature-state height
		// sync above). If the request fails the layer just stays empty; the
		// map works without it.
		map.addSource("buildings-rcn", {
			type: "geojson",
			data: apiUrl("/api/buildings/geojson"),
		});
		map.addLayer({
			id: "3d-building",
			type: "fill-extrusion",
			source: "buildings-rcn",
			minzoom: 13,
			paint: {
				"fill-extrusion-color": "#f59e0b",
				"fill-extrusion-height": [
					// Take whichever is taller: the OSM-tag estimate or
					// the basemap's own real height for this building
					// (synced via feature-state; 0 until then). +2 m
					// keeps our walls above the co-planar surfaces.
					"max",
					["+", ["get", "height"], 2],
					["+", ["number", ["feature-state", "baseHeight"], 0], 2],
				],
				"fill-extrusion-base": 0,
				// Fully opaque: any transparency lets the Standard
				// style's own extrusion bleed through as stripes.
				"fill-extrusion-opacity": 1,
				"fill-extrusion-vertical-gradient": false,
			},
		});
		// Queue a height sync for the initial viewport (the
		// idle handler consumes it once the style is ready).
		amberSyncQueued = true;

		// Address labels on 3D footprints (street + housenumber),
		// visible when zoomed in close. The source starts empty and
		// is refilled from the current viewport at zoom >= 16: the
		// unbounded payload was 38 MB, and only a screenful renders.
		map.addSource("building-labels", {
			type: "geojson",
			data: { type: "FeatureCollection", features: [] },
		});
		map.addLayer({
			id: "building-address-labels",
			type: "symbol",
			source: "building-labels",
			minzoom: LABEL_MIN_ZOOM,
			layout: {
				"text-field": ["get", "address"],
				"text-size": 10,
				"text-offset": [0, 0.6],
				"text-anchor": "top",
				"text-allow-overlap": false,
			},
			paint: {
				"text-color": "#e2e8f0",
				"text-halo-color": "#0f172a",
				"text-halo-width": 1.5,
			},
		});
		let labelsKey = "";
		const syncLabels = () => {
			const source = map.getSource("building-labels") as
				| mapboxgl.GeoJSONSource
				| undefined;
			if (!source || !("setData" in source)) return;
			if (map.getZoom() < LABEL_MIN_ZOOM) {
				source.setData({ type: "FeatureCollection", features: [] });
				labelsKey = "";
				return;
			}
			const bounds = map.getBounds();
			if (!bounds) return;
			const round = (value: number) => Math.round(value * 1e5) / 1e5;
			const key = [
				round(bounds.getWest()),
				round(bounds.getSouth()),
				round(bounds.getEast()),
				round(bounds.getNorth()),
			].join(",");
			if (key === labelsKey) return;
			labelsKey = key;
			source.setData(apiUrl(`/api/buildings/labels?bbox=${key}`));
		};
		map.on("moveend", syncLabels);
		syncLabels();
		map.on("mouseenter", "3d-building", () => {
			map.getCanvas().style.cursor = "pointer";
		});
		map.on("mouseleave", "3d-building", () => {
			map.getCanvas().style.cursor = "";
		});
		map.on("click", "3d-building", (event) =>
			showBuildingHistory(map, event, popupRef),
		);
	};
	if (map.getZoom() >= BUILDING_LAYERS_MINZOOM) {
		addBuildingLayers();
	} else {
		const maybeAdd = () => {
			if (map.getZoom() >= BUILDING_LAYERS_MINZOOM) {
				map.off("zoomend", maybeAdd);
				addBuildingLayers();
			}
		};
		map.on("zoomend", maybeAdd);
	}
}
