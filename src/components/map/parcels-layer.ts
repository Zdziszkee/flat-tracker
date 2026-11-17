import mapboxgl from "mapbox-gl";

import type { ParcelLookup } from "#/types/transactions";
import { POPUP_CLASS } from "./chrome";
import { parcelPopupHtml } from "./popups";
import type { ParcelFeatureCollection, PopupRef } from "./types";
import { flatViewportBbox } from "./viewport";

/** Below this zoom a viewport holds more parcels than the API caps at. */
const PARCEL_MIN_ZOOM = 14;
const PARCEL_LAYER_IDS = ["parcel-fill", "parcel-outline", "parcel-labels"];

function setParcelsVisible(map: mapboxgl.Map, visible: boolean): void {
	for (const id of PARCEL_LAYER_IDS) {
		if (map.getLayer(id)) {
			map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
		}
	}
}

/**
 * Cadastral parcels (podział geodezyjny, region-wide).
 *
 * `parcels` mixes RCN_Dzialka (Kraków) with GUGiK KIEG WFS rows for the rest
 * of małopolska (import-egib.ts). Drawn Geoportal-style: thin dark boundaries
 * + działka IDs, no fills; RCN colouring belongs to the 3D buildings. The
 * invisible fill layer stays as the click-catcher for the parcel history
 * popup.
 *
 * Only from z14: below that a viewport holds 15k-25k parcels in Kraków while
 * the API caps at 12k, so the grid came back partial and megabyte-heavy on
 * every camera move. Above the gate the worst case is ~5k parcels, and syncs
 * are debounced, abortable and skipped while the viewport stays inside the
 * fetched bbox.
 */
export function createParcelsLayer(
	map: mapboxgl.Map,
	popupRef: PopupRef,
	initialVisible = false,
) {
	let visible = initialVisible;
	let parcelsSeq = 0;
	let parcelBounds: [number, number, number, number] | null = null;
	let parcelAbort: AbortController | null = null;
	let parcelTimer: ReturnType<typeof setTimeout> | null = null;

	// Slot-free on purpose: Mapbox Standard renders a custom layer added to
	// the "middle" slot *under* the basemap's own landcover and building
	// fills, which made the grid invisible. Without a slot the layer sits
	// above the basemap (and below place labels).
	if (!map.getSource("parcels")) {
		map.addSource("parcels", {
			type: "geojson",
			data: { type: "FeatureCollection", features: [] },
		});
	}
	// RCN-history parcels get a faint amber tint; the rest stay invisible
	// but still act as the click-catcher (fills hit-test at opacity 0).
	map.addLayer({
		id: "parcel-fill",
		type: "fill",
		source: "parcels",
		layout: { visibility: "none" },
		paint: {
			"fill-color": ["case", ["get", "hasRcn"], "#f59e0b", "#000000"],
			"fill-opacity": ["case", ["get", "hasRcn"], 0.16, 0],
		},
	});
	// Cadastral boundaries, Geoportal podział gruntów look.
	map.addLayer({
		id: "parcel-outline",
		type: "line",
		source: "parcels",
		layout: { visibility: "none" },
		paint: {
			"line-color": "#94a3b8",
			"line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.5, 17, 2.4],
			"line-opacity": [
				"interpolate",
				["linear"],
				["zoom"],
				13.5,
				0.7,
				15,
				0.9,
				17,
				1,
			],
		},
	});
	// Działka IDs at parcel centroids, like geoportal's identyfikator.
	map.addLayer({
		id: "parcel-labels",
		type: "symbol",
		source: "parcels",
		minzoom: 15,
		layout: {
			visibility: "none",
			"text-field": ["get", "parcelId"],
			"text-font": ["DIN Pro Medium", "Noto Sans Regular"],
			"text-size": ["interpolate", ["linear"], ["zoom"], 15, 9.5, 17, 12],
			"text-letter-spacing": 0.05,
		},
		paint: {
			"text-color": "#94a3b8",
			"text-halo-color": "#0f172a",
			"text-halo-width": 1.2,
			"text-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.6, 1],
		},
	});

	/** Flat-camera viewport bbox with 10% padding (see flatViewportBbox). */
	const parcelBbox = () => flatViewportBbox(map);

	const sync = (force = false) => {
		if (!visible || map.getZoom() < PARCEL_MIN_ZOOM) {
			parcelAbort?.abort();
			parcelAbort = null;
			setParcelsVisible(map, false);
			return;
		}
		const bbox = parcelBbox();
		const covered =
			parcelBounds !== null &&
			bbox[0] >= parcelBounds[0] &&
			bbox[1] >= parcelBounds[1] &&
			bbox[2] <= parcelBounds[2] &&
			bbox[3] <= parcelBounds[3];
		if (!force && covered) {
			setParcelsVisible(map, true);
			return;
		}
		const seq = ++parcelsSeq;
		parcelAbort?.abort();
		const controller = new AbortController();
		parcelAbort = controller;
		const params = new URLSearchParams({
			minLng: String(bbox[0]),
			minLat: String(bbox[1]),
			maxLng: String(bbox[2]),
			maxLat: String(bbox[3]),
			// Drives server-side ring simplification.
			zoom: String(map.getZoom()),
		});
		void fetch(`/api/parcels?${params.toString()}`, {
			signal: controller.signal,
		})
			.then((r) => r.json())
			.then((fc: ParcelFeatureCollection) => {
				if (seq !== parcelsSeq) return; // stale response
				const src = map.getSource("parcels") as
					| mapboxgl.GeoJSONSource
					| undefined;
				src?.setData(fc);
				parcelBounds = bbox;
				setParcelsVisible(map, true);
			})
			.catch(() => {
				// Aborted or offline: keep whatever grid is on screen.
			});
	};

	// Refetch once the camera settles, so a burst of wheel-zoom steps
	// results in one request for the final viewport.
	const schedule = () => {
		if (parcelTimer) clearTimeout(parcelTimer);
		parcelTimer = setTimeout(() => sync(), 250);
	};
	map.on("moveend", schedule);

	// Parcel popups mirror building history.
	map.on("click", "parcel-fill", (e) => {
		// Click priority: listing points > 3D buildings > parcels. Both
		// higher layers dispatch their own handlers for the same click;
		// bail when one of them covers this point so only the winner pops.
		if (
			(() => {
				// The building layer is created lazily and may not exist
				// yet; queryRenderedFeatures throws for unknown layers.
				const covering = [
					"listings-circle",
					"listings-cluster",
					"listings-cluster-count",
					"komornik-listings",
					"3d-building",
				].filter((id) => map.getLayer(id));
				return (
					covering.length > 0 &&
					map.queryRenderedFeatures(e.point, { layers: covering }).length > 0
				);
			})()
		) {
			return;
		}
		const props = (
			e.features?.[0] as unknown as {
				properties?: {
					parcelId?: string;
					obreb?: string | null;
					gmina?: string | null;
				};
			}
		)?.properties;
		const pid = props?.parcelId;
		if (!pid) return;
		const where =
			props?.gmina || props?.obreb
				? `${props.gmina ?? ""}${
						props.gmina && props.obreb ? " · " : ""
					}${props.obreb ?? ""}`
				: null;
		e.preventDefault();
		void fetch(`/api/parcels/lookup?parcelId=${encodeURIComponent(pid)}`)
			.then((r) => r.json())
			.then((data: ParcelLookup) => {
				popupRef.current?.remove();
				const popup = new mapboxgl.Popup({
					className: POPUP_CLASS,
					offset: 10,
					closeButton: false,
					maxWidth: "320px",
				})
					.setLngLat(e.lngLat)
					.setHTML(parcelPopupHtml(data, where))
					.addTo(map);
				popupRef.current = popup;
			})
			.catch(() => {});
	});
	map.on("mouseenter", "parcel-fill", () => {
		map.getCanvas().style.cursor = "pointer";
	});
	map.on("mouseleave", "parcel-fill", () => {
		map.getCanvas().style.cursor = "";
	});

	const setVisible = (next: boolean) => {
		visible = next;
		if (next) {
			// Turning it on while zoomed out keeps it hidden until the
			// camera is close enough; force a fetch at the right zoom.
			sync(true);
		} else {
			sync();
		}
	};

	const dispose = () => {
		parcelAbort?.abort();
		if (parcelTimer) clearTimeout(parcelTimer);
	};

	// Initial pass for a map opened already inside the layer's zoom range.
	sync(true);

	return { sync: () => sync(true), setVisible, dispose };
}
