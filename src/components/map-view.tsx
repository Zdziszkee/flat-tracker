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

/** Krakow bounding box — the tracker only covers Krakow. */
const KRAKOW_BOUNDS: [[number, number], [number, number]] = [
	[19.75, 49.95],
	[20.25, 50.15],
];
const KRAKOW_CENTER: [number, number] = [19.94, 50.06];

const TOKEN = env.VITE_MAPBOX_TOKEN;

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
		id: number;
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
			}>;
		};
	} | null;
}

function buildingPopupHtml(data: BuildingLookup): string {
	if (!data?.building) {
		return `<div class="min-w-48 p-1 text-sm text-gray-600">
      <div class="font-medium">Budynek</div>
      <div>Brak danych historycznych dla tego budynku.</div>
    </div>`;
	}
	const b = data.building;
	const s = b.stats;
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
						.map(
							(t) =>
								`<div class="flex justify-between gap-3">
                  <span>${t.date.slice(0, 7)}</span>
                  <span>${t.price.toLocaleString("pl-PL")} zł${t.areaM2 ? ` · ${Math.round(t.areaM2)} m²` : ""}${t.pricePerM2 ? ` · ${Math.round(t.pricePerM2).toLocaleString("pl-PL")} zł/m²` : ""}</span>
                </div>`,
						)
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
}: {
	source: "all" | "otodom" | "olx";
}) {
	const { data, isLoading, error } = useQuery<ListingsResponse>({
		queryKey: ["listings"],
		queryFn: () => fetch("/api/listings").then((r) => r.json()),
	});

	const listings = (data?.listings ?? []).filter(
		(l) => source === "all" || l.source === source,
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
			center: KRAKOW_CENTER,
			zoom: 12.5,
			pitch: 45,
			bearing: -20,
			maxBounds: KRAKOW_BOUNDS,
			accessToken: TOKEN,
		});
		mapRef.current = map;

		map.addControl(
			new mapboxgl.NavigationControl({ visualizePitch: true }),
			"top-right",
		);

		map.on("load", () => {
			// 3D buildings from Mapbox's composite source (OSM-derived).
			map.addLayer(
				{
					id: "3d-buildings",
					source: "composite",
					"source-layer": "building",
					filter: ["==", "extrude", "true"],
					type: "fill-extrusion",
					minzoom: 14.5,
					paint: {
						"fill-extrusion-color": "#c8c8cc",
						"fill-extrusion-height": ["coalesce", ["get", "height"], 0],
						"fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
						"fill-extrusion-opacity": 0.55,
					},
				},
				"waterway-label",
			);

			// Listings as a GeoJSON circle layer (fast with thousands of points).
			map.addSource("listings", {
				type: "geojson",
				data: toGeoJson(listings),
			});
			map.addLayer({
				id: "listings-circle",
				type: "circle",
				source: "listings",
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

			map.on("mouseenter", "3d-buildings", () => {
				map.getCanvas().style.cursor = "pointer";
			});
			map.on("mouseleave", "3d-buildings", () => {
				map.getCanvas().style.cursor = "";
			});
			// Click a 3D building to see its RCN price history.
			map.on("click", "3d-buildings", (e) => {
				// If a listing dot is under the cursor, the listing popup wins.
				if (
					map.queryRenderedFeatures(e.point, {
						layers: ["listings-circle"],
					}).length > 0
				) {
					return;
				}
				void fetch(
					`/api/buildings/lookup?lat=${e.lngLat.lat}&lng=${e.lngLat.lng}`,
				)
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
			});

			map.on("mouseenter", "listings-circle", () => {
				map.getCanvas().style.cursor = "pointer";
			});
			map.on("mouseleave", "listings-circle", () => {
				map.getCanvas().style.cursor = "";
			});
			map.on("click", "listings-circle", (e) => {
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
			});
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
