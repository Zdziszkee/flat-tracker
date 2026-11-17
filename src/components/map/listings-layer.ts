import type { GeoJSONSource, Map as MapboxMap } from "mapbox-gl";

import type { KindFilter } from "#/lib/listing-features";
import type { MapFeedResponse } from "#/types/listing";
import { makeBudujesieIcon, makeKomornikIcon, sourceColorExpr } from "./icons";
import { showListingPopup } from "./listing-popup";
import type { MapFeedFeatureCollection, PopupRef } from "./types";
import { flatViewportBbox } from "./viewport";

/** Filter state the viewport feed reads on every request. */
export interface ListingFilters {
	source: string;
	days: 0 | 1 | 7 | 30;
	offerType: "all" | "sale" | "rental";
	kind: KindFilter;
}

/**
 * The map source only needs geometry plus the compact feed properties. The
 * old feed put the whole listing DTO (attributes, features, transaction
 * stats) into every feature, which made Mapbox serialize ~66 MB twice on the
 * first load.
 */
function feedToGeoJson(
	points: MapFeedResponse["points"],
): MapFeedFeatureCollection {
	return {
		type: "FeatureCollection",
		features: points.map((point) => ({
			type: "Feature",
			geometry: {
				type: "Point",
				coordinates:
					point.kind === "cluster"
						? [point.lng, point.lat]
						: [point.mapLng, point.mapLat],
			},
			properties: point,
		})),
	};
}

const LISTING_LAYER_IDS = [
	"listings-cluster",
	"listings-cluster-count",
	"listings-circle",
	"komornik-listings",
	"budujesie-listings",
];

/** Adds the `listings` source, its aggregated/point layers and popups. */
export function addListingsLayers(map: MapboxMap, popupRef: PopupRef): void {
	// Listings as a GeoJSON circle layer (fast with thousands of points).
	map.addSource("listings", {
		type: "geojson",
		data: { type: "FeatureCollection", features: [] },
	});
	// Overview cells: one circle per aggregated cell, sized by count.
	map.addLayer({
		id: "listings-cluster",
		type: "circle",
		source: "listings",
		filter: ["==", ["get", "kind"], "cluster"],
		paint: {
			"circle-color": sourceColorExpr(),
			"circle-radius": [
				"interpolate",
				["linear"],
				["get", "count"],
				1,
				6,
				10,
				11,
				100,
				17,
				1000,
				25,
			],
			"circle-opacity": 0.9,
			"circle-stroke-color": "#ffffff",
			"circle-stroke-width": 1.5,
		},
	});
	map.addLayer({
		id: "listings-cluster-count",
		type: "symbol",
		source: "listings",
		filter: ["==", ["get", "kind"], "cluster"],
		layout: {
			"text-field": ["to-string", ["get", "count"]],
			"text-font": ["DIN Pro Medium", "Noto Sans Regular"],
			"text-size": 11,
			"text-allow-overlap": true,
		},
		paint: {
			"text-color": "#ffffff",
			"text-halo-color": "rgba(0,0,0,0.35)",
			"text-halo-width": 1,
		},
	});
	map.addLayer({
		id: "listings-circle",
		type: "circle",
		source: "listings",
		// Komornik offers and budujesie investments get their own symbol
		// layers below.
		filter: [
			"all",
			["==", ["get", "kind"], "listing"],
			["!=", ["get", "source"], "licytacje-komornik"],
			["!=", ["get", "source"], "budujesie"],
		],
		paint: {
			"circle-color": sourceColorExpr(),
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 16, 9],
			"circle-stroke-color": "#ffffff",
			"circle-stroke-width": 1,
		},
	});

	// Court-auction offers render as a distinct diamond symbol.
	if (!map.hasImage("komornik-icon")) {
		map.addImage("komornik-icon", makeKomornikIcon());
	}
	if (!map.getLayer("komornik-listings")) {
		map.addLayer({
			id: "komornik-listings",
			type: "symbol",
			source: "listings",
			filter: [
				"all",
				["==", ["get", "kind"], "listing"],
				["==", ["get", "source"], "licytacje-komornik"],
			],
			layout: {
				"icon-image": "komornik-icon",
				"icon-size": 0.65,
				"icon-allow-overlap": true,
			},
		});
	}

	// Investments under construction (budujesie.pl) render as a hard hat.
	if (!map.hasImage("budujesie-icon")) {
		map.addImage("budujesie-icon", makeBudujesieIcon());
	}
	if (!map.getLayer("budujesie-listings")) {
		map.addLayer({
			id: "budujesie-listings",
			type: "symbol",
			source: "listings",
			filter: [
				"all",
				["==", ["get", "kind"], "listing"],
				["==", ["get", "source"], "budujesie"],
			],
			layout: {
				"icon-image": "budujesie-icon",
				"icon-size": 0.75,
				"icon-allow-overlap": true,
			},
		});
	}

	for (const layer of LISTING_LAYER_IDS) {
		map.on("mouseenter", layer, () => {
			map.getCanvas().style.cursor = "pointer";
		});
		map.on("mouseleave", layer, () => {
			map.getCanvas().style.cursor = "";
		});
		map.on("click", layer, (event) => showListingPopup(map, event, popupRef));
	}
}

/**
 * Fetch only what the current camera shows. The server returns grid cells
 * below zoom 13 and exact compact points above it, so no request ever
 * downloads the full ~47k-offer dataset.
 */
export function createListingsFeed(
	map: MapboxMap,
	getFilters: () => ListingFilters,
) {
	let abort: AbortController | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let seq = 0;

	const sync = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const sourceLayer = map.getSource("listings");
		if (!sourceLayer || !("setData" in sourceLayer)) return;
		// Flat-camera viewport with 10% padding (see flatViewportBbox).
		const [minLng, minLat, maxLng, maxLat] = flatViewportBbox(map);
		const f = getFilters();
		const params = new URLSearchParams({
			view: "map",
			minLng: String(minLng),
			minLat: String(minLat),
			maxLng: String(maxLng),
			maxLat: String(maxLat),
			zoom: map.getZoom().toFixed(2),
			source: f.source,
			days: String(f.days),
			kind: f.kind,
			offerType: f.offerType,
		});
		const requestSeq = ++seq;
		abort?.abort();
		const controller = new AbortController();
		abort = controller;
		void fetch(`/api/listings?${params.toString()}`, {
			signal: controller.signal,
		})
			.then((response) => {
				if (!response.ok) {
					throw new Error(`map feed ${response.status}`);
				}
				return response.json() as Promise<MapFeedResponse>;
			})
			.then((feed) => {
				if (requestSeq !== seq) return;
				const current = map.getSource("listings");
				if (current && "setData" in current) {
					(current as GeoJSONSource).setData(feedToGeoJson(feed.points));
				}
			})
			.catch(() => {
				// Aborted or offline: keep the previous pins on screen.
			});
	};

	const schedule = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(sync, 250);
	};

	const dispose = () => {
		abort?.abort();
		if (timer) clearTimeout(timer);
	};

	map.on("moveend", schedule);
	return { sync, schedule, dispose };
}
