import { useQuery } from "@tanstack/react-query";
import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";

import "mapbox-gl/dist/mapbox-gl.css";

import { env } from "#/env";

export interface ApiListing {
	id: number;
	source: string;
	externalId: string;
	url: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
	district: string | null;
	lat: number | null;
	lng: number | null;
	listedAt: string | null;
	firstSeenAt: string | null;
	heatingType: string | null;
	propertyType: string | null;
	features: string | null;
	buildingId: number | null;
	buildingAddress: string | null;
	mapLat: number | null;
	mapLng: number | null;
	transactionStats: {
		buildingId: number;
		address: string | null;
		txCount: number;
		txAvgPricePerM2: number | null;
		txMinDate: string | number | null;
		txMaxDate: string | number | null;
	} | null;
}

interface ListingsResponse {
	listings: ApiListing[];
	summary: unknown[];
	generatedAt: string;
}

/** Małopolska voivodeship bounding box. */
const MALOPOLSKA_BOUNDS: [[number, number], [number, number]] = [
	[19.0, 49.1],
	[21.6, 50.6],
];
const MALOPOLSKA_CENTER: [number, number] = [20.25, 49.85];

const TOKEN = env.VITE_MAPBOX_TOKEN;

/** Draw the court-auction diamond marker as raw pixels (SVG loadImage is flaky). */
function makeKomornikIcon(): ImageData {
	const size = 28;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		ctx.fillStyle = "#7c3aed";
		ctx.strokeStyle = "#ffffff";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(size / 2, 2);
		ctx.lineTo(size - 2, size / 2);
		ctx.lineTo(size / 2, size - 2);
		ctx.lineTo(2, size / 2);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		return ctx.getImageData(0, 0, size, size);
	}
	return new ImageData(size, size);
}

function formatPln(n: number | null): string {
	if (n === null) return "n/d";
	return new Intl.NumberFormat("pl-PL", {
		style: "currency",
		currency: "PLN",
		maximumFractionDigits: 0,
	}).format(n);
}

/** Extract the 4-digit year from a date string ("2022-05-30") or unix timestamp. */
function yearOf(d: string | number | null | undefined): string {
	if (d === null || d === undefined) return "";
	if (typeof d === "number") {
		return new Date(d * 1000).getUTCFullYear().toString();
	}
	return d.slice(0, 4);
}

/** 0 = no time window; otherwise keep offers listed within the last N days. */
function addedWithin(listedAt: string | null, days: 0 | 1 | 7 | 30): boolean {
	if (days === 0) return true;
	if (!listedAt) return false;
	return Date.now() - new Date(listedAt).getTime() <= days * 24 * 3600 * 1000;
}

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function popupHtml(l: ApiListing): string {
	const stats = l.transactionStats;
	const minYear = yearOf(stats?.txMinDate);
	const maxYear = yearOf(stats?.txMaxDate);
	const range = minYear && maxYear ? ` (${minYear}-${maxYear})` : "";
	const added = l.listedAt ?? l.firstSeenAt;
	const addedLabel = added
		? new Date(added).toLocaleDateString("pl-PL")
		: "n/d";
	return `
    <div class="min-w-56 space-y-1 text-sm">
      <div class="font-semibold leading-tight">${escapeHtml(l.title)}</div>
      <div class="text-gray-500">
        ${escapeHtml(l.district ?? "Kraków")}${l.buildingAddress ? ` · ${escapeHtml(l.buildingAddress)}` : ""}
      </div>
      <div class="flex justify-between gap-4 pt-1">
        <span class="font-medium">${formatPln(l.price)}</span>
        <span>${l.pricePerM2 ? `${l.pricePerM2.toFixed(0)} zł/m²` : ""}</span>
      </div>
      <div class="text-gray-500">
        ${l.areaM2 ? `${l.areaM2} m²` : ""}${l.rooms ? ` · ${l.rooms} pok.` : ""}${l.floor ? ` · ${escapeHtml(l.floor)}` : ""}
      </div>
      <div class="text-gray-400">Dodano: ${addedLabel}</div>
      ${
				stats
					? `<div class="border-t pt-1 text-xs">
          <div class="font-medium text-amber-700">RCN history: ${stats.txCount} transakcji</div>
          <div>Śr. ${formatPln(stats.txAvgPricePerM2)}/m²${range}</div>
        </div>`
					: ""
			}
      <a href="${l.url}" target="_blank" rel="noreferrer" class="mt-1 block text-blue-600 underline">Otwórz ogłoszenie</a>
    </div>`;
}

interface BuildingLookup {
	building: {
		id: number | null;
		osmId: number;
		address: string | null;
		lat: number;
		lng: number;
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

function buildingPopupHtml(data: BuildingLookup): string {
	if (!data?.building) {
		return `<div class="min-w-48 p-1 text-sm text-gray-600">
      <div class="font-medium">Budynek</div>
      <div>Brak danych o tym budynku.</div>
    </div>`;
	}
	const b = data.building;
	const s = b.stats;
	if (!s) {
		// Building found but no RCN history (address fallback).
		return `<div class="min-w-56 space-y-1 text-sm">
      <div class="font-semibold">${escapeHtml(b.address ?? "Budynek (bez adresu)")}</div>
      <div class="text-xs text-gray-500">Brak transakcji RCN dla tego budynku.</div>
    </div>`;
	}
	const range =
		s.minDate && s.maxDate
			? ` (${s.minDate.slice(0, 4)}-${s.maxDate.slice(0, 4)})`
			: "";
	const byYear =
		s.byYear.length > 0
			? `<div class="mt-1 border-t pt-1">
          ${s.byYear
						.map(
							(y) =>
								`<div class="flex justify-between gap-3">
                  <span>${y.year}: ${y.count} ${y.count === 1 ? "transakcja" : y.count < 5 ? "transakcje" : "transakcji"}</span>
                  <span class="font-medium">${s.avgPricePerM2 ? `${Math.round(y.avgPricePerM2 ?? 0).toLocaleString("pl-PL")} zł/m²` : ""}</span>
                </div>`,
						)
						.join("")}
        </div>`
			: "";
	const recent =
		s.recent.length > 0
			? `<div class="mt-1 border-t pt-1 text-xs">
          ${s.recent
						.map((t) => {
							const addr = t.street
								? `${escapeHtml(t.street)}${t.streetNumber ? ` ${escapeHtml(t.streetNumber)}` : ""}`
								: null;
							return `<div class="flex justify-between gap-3">
                  <span>${t.date.slice(0, 7)}${addr ? ` · ${addr}` : ""}</span>
                  <span>${t.price.toLocaleString("pl-PL")} zł${t.areaM2 ? ` · ${Math.round(t.areaM2)} m²` : ""}${t.pricePerM2 ? ` · ${Math.round(t.pricePerM2).toLocaleString("pl-PL")} zł/m²` : ""}</span>
                </div>`;
						})
						.join("")}
        </div>`
			: "";
	return `<div class="min-w-60 space-y-1 text-sm">
    <div class="font-semibold">${escapeHtml(b.address ?? "Budynek (bez adresu)")}</div>
    <div class="text-xs text-gray-500">Historia transakcji RCN</div>
    ${
			s.txCount > 0
				? `<div class="border-t pt-1">
          <div class="flex justify-between gap-3"><span>Liczba transakcji</span><span class="font-medium">${s.txCount}${range}</span></div>
          <div class="flex justify-between gap-3"><span>Średnia cena</span><span class="font-medium">${s.avgPricePerM2 ? `${Math.round(s.avgPricePerM2).toLocaleString("pl-PL")} zł/m²` : "n/d"}</span></div>
          <div class="flex justify-between gap-3"><span>Zakres</span><span>${s.minPricePerM2 ? `${Math.round(s.minPricePerM2).toLocaleString("pl-PL")} – ${Math.round(s.maxPricePerM2 ?? 0).toLocaleString("pl-PL")} zł/m²` : "n/d"}</span></div>
        </div>${byYear}${recent}`
				: `<div class="text-xs text-gray-500">Brak transakcji w tym budynku.</div>`
		}
  </div>`;
}

type GeoJsonFeatureCollection = {
	type: "FeatureCollection";
	features: Array<{
		type: "Feature";
		geometry: { type: "Point"; coordinates: number[] };
		properties: ApiListing;
	}>;
};

type AddressLabelFeatureCollection = {
	type: "FeatureCollection";
	features: Array<{
		type: "Feature";
		geometry: { type: "Point"; coordinates: number[] };
		properties: { osmId: number; address: string };
	}>;
};

function toGeoJson(listings: ApiListing[]): GeoJsonFeatureCollection {
	return {
		type: "FeatureCollection",
		features: listings
			.filter((l) => l.mapLat !== null && l.mapLng !== null)
			.map((l) => ({
				type: "Feature",
				geometry: {
					type: "Point",
					coordinates: [l.mapLng as number, l.mapLat as number],
				},
				properties: l,
			})),
	};
}

export default function MapView({
	source,
	days,
}: {
	source: string;
	days: 0 | 1 | 7 | 30;
}) {
	const { data, isLoading, error } = useQuery<ListingsResponse>({
		queryKey: ["listings"],
		queryFn: () => fetch("/api/listings").then((r) => r.json()),
	});

	const listings = (data?.listings ?? []).filter(
		(l) =>
			(source === "all" || l.source === source) &&
			addedWithin(l.listedAt ?? l.firstSeenAt, days),
	);

	if (!TOKEN) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-700">
				Brak klucza VITE_MAPBOX_TOKEN w .env.local — mapa nie działa bez tokena
				Mapbox.
			</div>
		);
	}

	return (
		<div className="relative h-full w-full">
			{isLoading && (
				<div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 text-sm text-gray-600">
					Ładowanie ofert...
				</div>
			)}
			{error && (
				<div className="absolute inset-0 z-10 flex items-center justify-center bg-red-50 p-4 text-sm text-red-700">
					Nie udało się pobrać danych: {String(error)}
				</div>
			)}
			<MapCanvas listings={listings} />

			<footer className="pointer-events-none absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-4 rounded-lg bg-white/90 px-4 py-1.5 text-xs text-gray-600 shadow">
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" />{" "}
					budynek z historią RCN
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-sm bg-gray-300" />{" "}
					bez historii
				</span>
				<span className="mx-1 h-3 w-px bg-gray-300" />
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />{" "}
					&lt;12k zł/m²
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-yellow-500" />{" "}
					12-15k
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-orange-500" />{" "}
					15-18k
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />{" "}
					&gt;18k zł/m²
				</span>
			</footer>
		</div>
	);
}

function MapCanvas({ listings }: { listings: ApiListing[] }) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<mapboxgl.Map | null>(null);
	const popupRef = useRef<mapboxgl.Popup | null>(null);

	// Create the map once. The listings snapshot at init is only used for
	// the initial source data; the effect below pushes updates on changes,
	// so `listings` is intentionally not a dependency here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (!containerRef.current || mapRef.current) return;

		const map = new mapboxgl.Map({
			container: containerRef.current,
			style: "mapbox://styles/mapbox/light-v11",
			center: MALOPOLSKA_CENTER,
			zoom: 9,
			pitch: 45,
			bearing: -20,
			maxBounds: MALOPOLSKA_BOUNDS,
			accessToken: TOKEN,
		});
		mapRef.current = map;

		map.addControl(
			new mapboxgl.NavigationControl({ visualizePitch: true }),
			"top-right",
		);

		map.on("load", () => {
			// All OSM buildings extruded in 3D (Mapbox composite source).
			// Buildings WITH RCN history get colored amber via feature-state
			// (keyed by OSM id), so the color uses the building's REAL height
			// from the Mapbox tiles - no separate overlay, no height mismatch.
			map.addLayer(
				{
					id: "3d-buildings",
					source: "composite",
					"source-layer": "building",
					filter: ["==", "extrude", "true"],
					type: "fill-extrusion",
					minzoom: 14.5,
					paint: {
						"fill-extrusion-color": [
							"case",
							["==", ["feature-state", "hasHistory"], true],
							"#e8a33d", // has RCN history: amber
							"#c8c8cc", // no history: gray
						],
						"fill-extrusion-height": ["coalesce", ["get", "height"], 0],
						"fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
						"fill-extrusion-opacity": 0.75,
					},
				},
				"waterway-label",
			);

			// Mark history buildings with feature-state. Composite building
			// features carry OSM ids (verified against our osm_buildings), so
			// setFeatureState colors exactly the right buildings.
			void fetch("/api/buildings/history-ids")
				.then((r) => r.json())
				.then((d: { osmIds: number[] }) => {
					for (const osmId of d.osmIds) {
						map.setFeatureState(
							{
								source: "composite",
								sourceLayer: "building",
								id: osmId,
							},
							{ hasHistory: true },
						);
					}
					console.log(`marked ${d.osmIds.length} buildings with history`);
				})
				.catch(() => {
					// Coloring is optional; the map works without it.
				});

			// Address labels on 3D footprints (street + housenumber),
			// visible when zoomed in close.
			void fetch("/api/buildings/labels")
				.then((r) => r.json())
				.then((fc: AddressLabelFeatureCollection) => {
					map.addSource("building-labels", { type: "geojson", data: fc });
					map.addLayer({
						id: "building-address-labels",
						type: "symbol",
						source: "building-labels",
						minzoom: 15.2,
						layout: {
							"text-field": ["get", "address"],
							"text-size": 10,
							"text-offset": [0, 0.6],
							"text-anchor": "top",
							"text-allow-overlap": false,
						},
						paint: {
							"text-color": "#3d3d3d",
							"text-halo-color": "#ffffff",
							"text-halo-width": 1.5,
						},
					});
				})
				.catch(() => {
					// Labels are optional; the map works without them.
				});

			// Listings as a GeoJSON circle layer (fast with thousands of points).
			map.addSource("listings", {
				type: "geojson",
				data: toGeoJson(listings),
			});
			map.addLayer({
				id: "listings-circle",
				type: "circle",
				source: "listings",
				// Komornik offers get their own symbol layer below.
				filter: ["!=", ["get", "source"], "licytacje-komornik"],
				paint: {
					"circle-color": [
						"step",
						["coalesce", ["get", "pricePerM2"], 0],
						"#10b981",
						12000,
						"#eab308",
						15000,
						"#f97316",
						18000,
						"#ef4444",
					],
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
					filter: ["==", ["get", "source"], "licytacje-komornik"],
					layout: {
						"icon-image": "komornik-icon",
						"icon-size": 0.65,
						"icon-allow-overlap": true,
					},
				});
			}

			// Click a 3D building to see its RCN price history.
			const showBuildingHistory = (e: mapboxgl.MapLayerMouseEvent) => {
				// If a listing marker is under the cursor, the listing popup wins.
				if (
					map.queryRenderedFeatures(e.point, {
						layers: ["listings-circle", "komornik-listings"],
					}).length > 0
				) {
					return;
				}
				// For 3D fill-extrusions, e.lngLat is the ground point, which
				// can be far from where the user visually clicked on a tall
				// building. Use the clicked feature's own geometry instead.
				const feature = map.queryRenderedFeatures(e.point, {
					layers: ["3d-buildings"],
				})[0] as
					| {
							geometry?: { type: string; coordinates?: number[][][][] };
							id?: number;
					  }
					| undefined;
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
							offset: 16,
							closeButton: false,
							maxWidth: "340px",
						})
							.setLngLat(e.lngLat)
							.setHTML(buildingPopupHtml(data))
							.addTo(map);
						popupRef.current = popup;
					})
					.catch(() => {
						// Ignore fetch errors; the map stays usable.
					});
			};
			map.on("mouseenter", "3d-buildings", () => {
				map.getCanvas().style.cursor = "pointer";
			});
			map.on("mouseleave", "3d-buildings", () => {
				map.getCanvas().style.cursor = "";
			});
			map.on("click", "3d-buildings", showBuildingHistory);

			const showListingPopup = (e: mapboxgl.MapLayerMouseEvent) => {
				const feature = e.features?.[0] as { properties?: unknown } | undefined;
				const props = feature?.properties;
				if (!props) return;
				const listing = props as ApiListing;
				popupRef.current?.remove();
				const popup = new mapboxgl.Popup({
					offset: 16,
					closeButton: false,
				})
					.setLngLat(e.lngLat)
					.setHTML(popupHtml(listing))
					.addTo(map);
				popupRef.current = popup;
			};

			for (const layer of ["listings-circle", "komornik-listings"]) {
				map.on("mouseenter", layer, () => {
					map.getCanvas().style.cursor = "pointer";
				});
				map.on("mouseleave", layer, () => {
					map.getCanvas().style.cursor = "";
				});
				map.on("click", layer, showListingPopup);
			}
		});

		return () => {
			map.remove();
			mapRef.current = null;
			popupRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Push updated listings into the source whenever the filter changes.
	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;
		const apply = () => {
			const src = map.getSource("listings");
			if (src && "setData" in src) {
				(src as mapboxgl.GeoJSONSource).setData(toGeoJson(listings));
			}
		};
		if (map.isStyleLoaded()) apply();
		else map.once("load", apply);
	}, [listings]);

	return <div ref={containerRef} className="h-full w-full" />;
}
