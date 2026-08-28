import { useQuery } from "@tanstack/react-query";
import mapboxgl from "mapbox-gl";
import { useEffect, useRef } from "react";

import "mapbox-gl/dist/mapbox-gl.css";

import { env } from "#/env";

interface ApiListing {
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
	address: string | null;
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
	offerType?: string;
	pricePeriod?: string | null;
	maxGuests?: number | null;
	bedrooms?: number | null;
	beds?: number | null;
	bathrooms?: number | null;
	rating?: number | null;
	reviewsCount?: number | null;
	availabilityCount?: number | null;
	minimumStayNights?: number | null;
	utilities?: string | null;
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

/** Distinct dot color per data source (legend + map points). */
const SOURCE_COLORS: Record<string, string> = {
	otodom: "#2563eb",
	olx: "#f97316",
	morizon: "#16a34a",
	gratka: "#4ade80",
	domiporta: "#a855f7",
	"nieruchomosci-online": "#ca8a04",
	rynekpierwotny: "#06b6d4",
	investmap: "#0891b2",
	airbnb: "#ff385c",
	booking: "#003580",
	books: "#8b5cf6",
	skaleczna: "#d946ef",
	"licytacje-komornik": "#6b7280",
};

/** Mapbox match expression coloring each point by its source. */
function sourceColorExpr(): mapboxgl.ExpressionSpecification {
	const pairs: string[] = [];
	for (const [src, color] of Object.entries(SOURCE_COLORS)) {
		pairs.push(src, color);
	}
	return [
		"match",
		["get", "source"],
		...pairs,
		"#94a3b8",
	] as mapboxgl.ExpressionSpecification;
}

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

/** Render parsed utility/administrative fees as a short "Czynsz: ..." line. */
function formatUtilities(json: string | null | undefined): string {
	if (!json) return "";
	try {
		const u = JSON.parse(json) as Record<string, number | null>;
		const parts: string[] = [];
		for (const [key, label] of [
			["czynsz", "czynsz"],
			["ogrzewanie", "ogrz."],
			["prad", "prąd"],
			["woda", "woda"],
			["gaz", "gaz"],
			["smieci", "śmieci"],
		] as Array<[string, string]>) {
			const v = u[key];
			if (typeof v === "number") parts.push(`${label} ${v} zł`);
		}
		return parts.length > 0 ? `Opłaty: ${parts.join(" · ")}` : "";
	} catch {
		return "";
	}
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
	const location = l.address ?? l.district ?? l.buildingAddress ?? "";

	// Physical layout: portal columns first, then Airbnb PDP extraction.
	// bedrooms wins over rooms so short-term rentals show sypialnie.
	const layoutParts: string[] = [];
	if (l.areaM2) layoutParts.push(`${l.areaM2} m²`);
	if (l.rooms && l.bedrooms == null) layoutParts.push(`${l.rooms} pok.`);
	if (l.bedrooms != null)
		layoutParts.push(
			l.bedrooms === 0
				? "kawalerka"
				: `${l.bedrooms} sypialn${l.bedrooms === 1 ? "ia" : "ie"}`,
		);
	if (l.beds != null)
		layoutParts.push(`${l.beds} łóż${l.beds === 1 ? "ko" : "ka"}`);
	if (l.bathrooms != null)
		layoutParts.push(
			`${String(l.bathrooms).replace(".", ",")} łazienk${l.bathrooms === 1 ? "a" : "i"}`,
		);
	if (l.maxGuests != null) layoutParts.push(`do ${l.maxGuests} gości`);
	if (l.floor) layoutParts.push(`piętro ${l.floor}`);
	if (l.propertyType) layoutParts.push(l.propertyType);
	const details = layoutParts.join(" · ");

	const heating = l.heatingType ? `Ogrzewanie: ${l.heatingType}` : "";
	const utilities = formatUtilities(l.utilities);

	// Short-term-rental context lines.
	const stayLines: string[] = [];
	if (l.minimumStayNights != null && l.minimumStayNights > 1)
		stayLines.push(
			`<div class="text-gray-500">Min. ${l.minimumStayNights} nocy</div>`,
		);
	if (l.availabilityCount != null && l.availabilityCount > 0)
		stayLines.push(
			`<div class="text-gray-500">Wolne ~${l.availabilityCount} nocy/rok</div>`,
		);

	// Amenities preview from the enriched features JSON.
	let amenitiesHtml = "";
	try {
		const f: unknown = l.features ? JSON.parse(l.features) : null;
		const amenities =
			f &&
			typeof f === "object" &&
			Array.isArray((f as Record<string, unknown>).amenities)
				? ((f as Record<string, unknown>).amenities as unknown[])
				: [];
		if (amenities.length > 0) {
			const shown = amenities.slice(0, 6).map((a) => escapeHtml(String(a)));
			const rest = amenities.length - shown.length;
			amenitiesHtml = `
      <div class="border-t pt-1 text-xs">
        <div class="font-medium text-emerald-700">Udogodnienia</div>
        <div class="text-gray-600">${shown.join(", ")}${
					rest > 0 ? ` <span class="text-gray-400">+${rest} więcej</span>` : ""
				}</div>
      </div>`;
		}
	} catch {
		// malformed features JSON: skip the section silently
	}

	return `
    <div class="min-w-56 space-y-1 text-sm">
      <div class="font-semibold leading-tight">${escapeHtml(l.title)}</div>
      <div class="text-gray-500">${escapeHtml(location)}</div>
      <div class="flex justify-between gap-4 pt-1">
        <span class="font-medium">${formatPln(l.price)}${
					l.pricePeriod === "night"
						? '<span class="text-xs font-normal text-gray-400"> /noc</span>'
						: ""
				}</span>
        <span>${l.pricePerM2 ? `${l.pricePerM2.toFixed(0)} zł/m²` : ""}</span>
      </div>
      <div class="text-gray-500">${escapeHtml(details)}</div>
      ${
				l.rating != null && l.rating > 0
					? `<div><span class="font-medium">${l.rating.toFixed(2)}</span> <span class="text-amber-500">★</span>${
							l.reviewsCount
								? ` <span class="text-gray-400">(${l.reviewsCount} opinii)</span>`
								: ""
						}</div>`
					: ""
			}
      ${heating ? `<div class="text-gray-500">${escapeHtml(heating)}</div>` : ""}
      ${utilities ? `<div class="text-gray-500">${escapeHtml(utilities)}</div>` : ""}
      ${stayLines.join("\n      ")}
      <div class="text-gray-400">Dodano: ${addedLabel}</div>
      ${amenitiesHtml}
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
	offerType,
}: {
	source: string;
	days: 0 | 1 | 7 | 30;
	offerType: "all" | "sale" | "rental";
}) {
	const { data, isLoading, error } = useQuery<ListingsResponse>({
		queryKey: ["listings"],
		queryFn: () => fetch("/api/listings").then((r) => r.json()),
	});

	const listings = (data?.listings ?? []).filter(
		(l) =>
			(source === "all" || l.source === source) &&
			addedWithin(l.listedAt ?? l.firstSeenAt, days) &&
			(offerType === "all" ||
				(offerType === "rental"
					? l.offerType !== "sale"
					: l.offerType === "sale")),
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
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-sm border border-amber-700/50 bg-amber-400/25" />{" "}
					działka z historią RCN
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
	// Latest listings snapshot, readable from the async map-load callback
	// no matter whether the API resolves before or after "load" fires.
	const listingsRef = useRef(listings);

	// Create the map once. The listings snapshot at init is only used for
	// the initial source data; the effect below pushes updates on changes,
	// so `listings` is intentionally not a dependency here.
	useEffect(() => {
		if (!containerRef.current || mapRef.current) return;

		const map = new mapboxgl.Map({
			container: containerRef.current,
			// Mapbox Standard core style: colorful basemap with native 3D
			// landmarks, trees, procedural buildings, dynamic light and
			// atmosphere sky. Our RCN feature-state coloring hooks into the
			// style's own select/highlight states (see below).
			style: "mapbox://styles/mapbox/standard",
			center: MALOPOLSKA_CENTER,
			zoom: 9,
			pitch: 45,
			bearing: -20,
			maxBounds: MALOPOLSKA_BOUNDS,
			accessToken: TOKEN,
		});
		mapRef.current = map;
		// Debug hook for browser-console inspection.
		(window as unknown as { __map?: mapboxgl.Map }).__map = map;

		map.addControl(
			new mapboxgl.NavigationControl({ visualizePitch: true }),
			"top-right",
		);

		// Terrain + hillshade, per docs.mapbox.com/mapbox-gl-js/example/add-terrain
		// and /example/hillshade: add the DEM source(s) and setTerrain in
		// `style.load`, which fires after every style (re)load. Terrain is
		// NOT part of the Standard fragment style — `mapbox-dem` there only
		// exists as an import-internal source, so we add our own.
		map.on("style.load", () => {
			if (!map.getSource("mapbox-dem")) {
				map.addSource("mapbox-dem", {
					type: "raster-dem",
					url: "mapbox://mapbox.mapbox-terrain-dem-v1",
					tileSize: 512,
					maxzoom: 14,
				});
			}
			map.setTerrain({ source: "mapbox-dem", exaggeration: 1.2 });
			// Hillshade in its own DEM source (sharing one source with
			// terrain halves hillshade resolution), slotted `bottom` so
			// every Standard basemap layer draws on top of the relief.
			if (!map.getSource("mapbox-dem-hillshade")) {
				map.addSource("mapbox-dem-hillshade", {
					type: "raster-dem",
					url: "mapbox://mapbox.mapbox-terrain-dem-v1",
					tileSize: 512,
					maxzoom: 14,
				});
			}
			if (!map.getLayer("hillshade-demo")) {
				map.addLayer({
					id: "hillshade-demo",
					type: "hillshade",
					source: "mapbox-dem-hillshade",
					slot: "bottom",
					paint: { "hillshade-exaggeration": 0.3 },
				});
			}
		});

		map.on("load", () => {
			// Softer daytime light so the colorful Standard palette reads well.
			try {
				map.setConfigProperty("basemap", "lightPreset", "day");
			} catch {
				// Older style versions ignore config presets.
			}

			// RCN history as OUR OWN fill-extrusion layer (amber). The
			// Standard style's `highlight` feature-state is unusable here:
			// per Mapbox docs the select/highlight coloring "does not work
			// for buildings represented as 3D models" — it paints only the
			// flat ground footprint while the extruded model stays gray.
			// A dedicated extrusion colors the actual volume. The click and
			// hover handlers below target this "3d-building" layer id.
			const amberByOsmId = new Map<number, number>();
			// Mapbox Standard exposes each basemap building's REAL height
			// (props.height) keyed by OSM id; our OSM-tag estimates default
			// to 12 m when tags are missing, so tall blocks would show
			// uncolored gray tops poking through the shell. Copy real
			// heights into per-feature states whenever the viewport changes.
			//
			// Queue + self-healing retry: a target-featureset query can throw
			// while the basemap import is still resolving; leaving the queue
			// armed makes the next idle (and there are many) finish the job.
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
					const blds = query.call(
						map,
						undefined,
						{ target: { featuresetId: "buildings", importId: "basemap" } },
					);
					for (const b of blds) {
						const h = b.properties?.height;
						const dbId =
							typeof b.id === "number" ? amberByOsmId.get(b.id) : undefined;
						if (dbId === undefined || typeof h !== "number" || h <= 0) {
							continue;
						}
						map.setFeatureState(
							{ source: "buildings-rcn", id: dbId },
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
			void fetch("/api/buildings/geojson")
				.then((r) => r.json())
				.then(
					(fc: {
						type: "FeatureCollection";
						features: Array<{
							type: "Feature";
							id: number;
							geometry: { type: "Polygon"; coordinates: number[][][] };
							properties: { height: number; osmId: number };
						}>;
					}) => {
						// The Standard style extrudes the SAME OSM footprints, so
						// identical walls z-fight/interleave (stripes). Expand
						// each ring ~2% about its centroid so our amber shell
						// fully encloses the basemap volume, and raise the roof
						// +1.5 m for the same reason.
						for (const f of fc.features) {
							amberByOsmId.set(f.properties.osmId, f.id);
							const ring = f.geometry.coordinates[0];
							let cx = 0;
							let cy = 0;
							for (const [x, y] of ring) {
								cx += x;
								cy += y;
							}
							cx /= ring.length;
							cy /= ring.length;
							for (const c of ring) {
								c[0] = cx + (c[0] - cx) * 1.02;
								c[1] = cy + (c[1] - cy) * 1.02;
							}
						}
						map.addSource("buildings-rcn", { type: "geojson", data: fc });
						map.addLayer({
							id: "3d-building",
							type: "fill-extrusion",
							source: "buildings-rcn",
							paint: {
								"fill-extrusion-color": "#f59e0b",
								// Prefer the basemap's own real height for this
								// building (set via feature-state by
								// syncAmberHeights); fall back to the OSM estimate.
								// Both get +2 m so walls clear co-planar surfaces.
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
						// Sync right away for the initial viewport (the persistent
						// idle handler re-runs it on every camera change).
						// Queue a height sync for the initial viewport (the
						// idle handler consumes it once the style is ready).
						amberSyncQueued = true;
					},
				)
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
				data: toGeoJson(listingsRef.current),
			});
			map.addLayer({
				id: "listings-circle",
				type: "circle",
				source: "listings",
				// Komornik offers get their own symbol layer below.
				filter: ["!=", ["get", "source"], "licytacje-komornik"],
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
					layers: ["3d-building"],
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
			map.on("mouseenter", "3d-building", () => {
				map.getCanvas().style.cursor = "pointer";
			});
			map.on("mouseleave", "3d-building", () => {
				map.getCanvas().style.cursor = "";
			});
			map.on("click", "3d-building", showBuildingHistory);

			// ---- Cadastral parcels (podział geodezyjny, region-wide) -----
			// `parcels` mixes RCN_Dzialka (Krakow) with GUGiK KIEG WFS rows
			// for the rest of małopolska (import-egib.ts). Viewport-limited
			// GeoJSON; refetched as the camera moves.
			// Rendered Geoportal-style (podział gruntów): thin dark boundary
			// lines + działka ID labels, NO fills — RCN coloring belongs to
			// the 3D buildings above. The fill layer stays as an invisible
			// click-catcher for the parcel history popup. Loaded at every
			// zoom (the API caps at 6000 features), so the layer is present
			// from boot.
			let parcelsSeq = 0;
			const loadParcels = () => {
				// With terrain enabled, map.getBounds() shrinks to the ground
				// footprint of the frustum — in hilly terrain (Podhale,
				// Beskidy) that can be a sliver tens of meters tall, emptying
				// the parcel grid. Compute a flat-camera bbox from
				// center+zoom instead (Web Mercator pixels-per-world-tile).
				const c = map.getCenter();
				const z = map.getZoom();
				const canvas = map.getCanvas();
				const w = canvas.clientWidth || canvas.width || 1200;
				const h = canvas.clientHeight || canvas.height || 800;
				const worldSpan = 360 / 2 ** z;
				const spanLng = worldSpan * (w / 512);
				const spanLat =
					(spanLng * (h / w)) / Math.max(0.3, Math.cos((c.lat * Math.PI) / 180));
				const padLng = spanLng * 0.1;
				const padLat = spanLat * 0.1;
				const seq = ++parcelsSeq;
				const params = new URLSearchParams({
					minLng: String(c.lng - spanLng / 2 - padLng),
					minLat: String(c.lat - spanLat / 2 - padLat),
					maxLng: String(c.lng + spanLng / 2 + padLng),
					maxLat: String(c.lat + spanLat / 2 + padLat),
					// Drives server-side ring simplification.
					zoom: String(z),
				});
				void fetch(`/api/parcels?${params.toString()}`)
					.then((r) => r.json())
					.then(
						(fc: {
							type: "FeatureCollection";
							features: Array<{
								type: "Feature";
								geometry: {
									type: "Polygon";
									coordinates: number[][][];
								};
								properties: { parcelId: string; hasRcn: boolean };
							}>;
						}) => {
							if (seq !== parcelsSeq) return; // stale response
							const src = map.getSource("parcels") as
								| mapboxgl.GeoJSONSource
								| undefined;
							if (src) {
								src.setData(fc);
								return;
							}
							map.addSource("parcels", { type: "geojson", data: fc });
							// RCN-history parcels get a faint amber tint; others
							// stay invisible but still act as the click-catcher
							// for parcel popups (fill layers are hit-tested at
							// opacity 0).
							map.addLayer({
								id: "parcel-fill",
								type: "fill",
								source: "parcels",
								// `middle` slot so hit-testing priority matches the
								// drawing order (above basemap fills, below labels).
								// With terrain enabled the geometry drapes onto the
								// DEM, so clicks track the relief.
								slot: "middle",
								paint: {
									"fill-color": [
										"case",
										["get", "hasRcn"],
										"#f59e0b",
										"#000000",
									],
									"fill-opacity": [
										"case",
										["get", "hasRcn"],
										0.16,
										0,
									],
								},
							});
							// Cadastral boundaries, Geoportal podział gruntów look:
							// thin dark lines, slightly stronger as you zoom in.
							map.addLayer({
								id: "parcel-outline",
								type: "line",
								source: "parcels",
								slot: "middle",
								paint: {
									"line-color": "#3d4652",
									"line-width": [
										"interpolate",
										["linear"],
										["zoom"],
										12,
										0.7,
										16,
										1.4,
									],
									"line-opacity": [
										"interpolate",
										["linear"],
										["zoom"],
										9,
										0.15,
										12,
										0.55,
										14,
										0.9,
									],
								},
							});
							// Działka IDs at parcel centroids, like geoportal's
							// identyfikator działki; fade in from z14.
							map.addLayer({
								id: "parcel-labels",
								type: "symbol",
								source: "parcels",
								slot: "middle",
								minzoom: 14,
								layout: {
									"text-field": ["get", "parcelId"],
									"text-font": ["DIN Pro Medium", "Noto Sans Regular"],
									"text-size": [
										"interpolate",
										["linear"],
										["zoom"],
										14,
										9.5,
										17,
										12,
									],
									"text-letter-spacing": 0.05,
								},
								paint: {
									"text-color": "#1f2937",
									"text-halo-color": "#ffffff",
									"text-halo-width": 1.2,
									"text-opacity": [
										"interpolate",
										["linear"],
										["zoom"],
										14,
										0,
										15,
										1,
									],
								},
							});
							// Parcel popups mirror building history.
							interface ParcelLookup {
								parcel: {
									id: string;
									area?: {
										unit: string;
										medianM2: number | null;
										txCount: number;
										txCount24m: number;
										lastVsMedianPct: number | null;
										basedOn: Array<{
											date: string;
											price: number;
											perUnit: number;
											parcelId: string;
										}>;
									} | null;
									meta?: {
										landUse: string | null;
										zoning: string | null;
										areaHa: number | null;
									} | null;
									stats: {
										txCount: number;
										avgPricePerM2: number | null;
										minPricePerM2: number | null;
										maxPricePerM2: number | null;
										recent: Array<{
											date: string;
											price: number;
											pricePerM2: number | null;
											areaM2: number | null;
											street: string | null;
											streetNumber: string | null;
										}>;
									};
								} | null;
							}
							map.on("click", "parcel-fill", (e) => {
								// Click priority: listing points > 3D buildings >
								// parcels. Both higher layers dispatch their own
								// handlers for the same click; bail when one of
								// them covers this point so only the winner pops.
								if (
									map.queryRenderedFeatures(e.point, {
										layers: [
											"listings-circle",
											"komornik-listings",
											"3d-building",
										],
									}).length > 0
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
								void fetch(
									`/api/parcels/lookup?parcelId=${encodeURIComponent(pid)}`,
								)
									.then((r) => r.json())
									.then((data: ParcelLookup) => {
										const s = data.parcel?.stats;
										const area = data.parcel?.area;
										const meta = data.parcel?.meta;
										const LAND_LABELS: Record<string, string> = {
											gruntyRolne: "rolna",
											gruntyZabudowaneIZurbanizowane: "budowlana/zurbanizowana",
											gruntyLesne: "leśna",
											terenyKomunikacyjne: "komunikacyjna",
											inne: "inna",
										};
										const landLabel =
											meta?.landUse != null
												? (LAND_LABELS[meta.landUse] ?? meta.landUse)
												: null;
										const areaAr =
											meta?.areaHa != null ? meta.areaHa * 100 : null;
										const unitLabel = area?.unit === "ar" ? "zł/ar" : "zł/m²";
										const fmtU = (n: number | null | undefined) =>
											n == null
												? "—"
												: `${Math.round(n * (area?.unit === "ar" ? 100 : 1)).toLocaleString("pl-PL")} ${unitLabel}`;
										const rows = (s?.recent ?? [])
											.map(
												(r) =>
													`<tr><td>${r.date}</td><td>${Math.round(
														r.price,
													).toLocaleString("pl-PL")} zł</td><td>${fmtU(
														r.pricePerM2,
													)}</td><td>${r.areaM2 ?? "?"} m²${
														r.street
															? ` · ${r.street} ${r.streetNumber ?? ""}`
															: ""
													}</td></tr>`,
											)
											.join("");
										const isAr = area?.unit === "ar";
										const areaHtml = area?.medianM2
											? `<div class="mt-1 border-t pt-1 text-xs">
													<div class="text-gray-500">Otoczenie (1 km, 5 lat): mediana <b>${(area.unit === "ar" ? Math.round(area.medianM2) : Math.round(area.medianM2 * 10) / 10).toLocaleString("pl-PL")} ${area.unit === "ar" ? "zł/ar" : "zł/m²"}</b> · ${area.txCount} transakcji (${area.txCount24m} w 24 mies.)</div>
													${area.lastVsMedianPct != null ? `<div class="${area.lastVsMedianPct <= -15 ? "text-emerald-600" : area.lastVsMedianPct >= 15 ? "text-red-600" : "text-gray-600"}">Ostatnia transakcja: <b>${area.lastVsMedianPct > 0 ? "+" : ""}${area.lastVsMedianPct}%</b> vs mediana okolicy</div>` : ""}
												</div>`
											: "";
										const html = `<div class="min-w-56 p-1 text-sm">
											<div class="font-medium">Działka ${pid}</div>
											${where ? `<div class="text-xs text-gray-500">${escapeHtml(where)}</div>` : ""}
											${landLabel || areaAr != null ? `<div class="text-xs text-gray-600">${landLabel ? `działka ${landLabel}` : ""}${landLabel && areaAr != null ? " · " : ""}${areaAr != null ? `${areaAr.toLocaleString("pl-PL")} ar` : ""}</div>` : ""}
											${
												s && s.txCount > 0
													? `<div class="mt-1">${s.txCount} transakcji RCN · średnio ${fmtU(
															s.avgPricePerM2,
														)}</div>
													<div class="text-gray-500">zakres ${fmtU(
														s.minPricePerM2,
													)} – ${fmtU(s.maxPricePerM2)}</div>
													${
														rows
															? `<table class="mt-2 w-full text-xs"><thead><tr class="text-left text-gray-500"><th>data</th><th>cena</th><th>${unitLabel}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
															: ""
													}`
													: `<div class="mt-1 text-gray-500">Brak transakcji RCN na tej działce.</div>`
											}
											${areaHtml}
											${
												area && area.basedOn.length > 0
													? `<div class="mt-1 text-xs text-gray-500">na podstawie ${area.basedOn.length} transakcji w okolicy:</div><table class="w-full text-xs"><tbody>${area.basedOn
															.map(
																(b) =>
																	`<tr><td>${b.date}</td><td class="text-right">${Math.round(b.price).toLocaleString("pl-PL")} zł</td><td class="text-right">${isAr ? `${Math.round(b.perUnit).toLocaleString("pl-PL")} zł/ar` : `${Math.round(b.perUnit)} zł/m²`}</td></tr>`,
															)
															.join("")}</tbody></table>`
													: ""
											}
										</div>`;
										popupRef.current?.remove();
										const popup = new mapboxgl.Popup({
											offset: 10,
											closeButton: false,
											maxWidth: "320px",
										})
											.setLngLat(e.lngLat)
											.setHTML(html)
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
						},
					)
					.catch(() => {});
			};
			loadParcels();
			map.on("moveend", loadParcels);

			interface OfferValuation {
				offer: { id: number; price: number | null; pricePerM2: number | null };
				comps: {
					building: { avgM2: number; n: number } | null;
					area: { avgM2: number; n: number } | null;
					rcn: { avgM2: number; n: number } | null;
					fairM2: number | null;
				};
				overUnderPct: number | null;
				rating: { label: string; tone: string } | null;
				lt: {
					rentAvg: number;
					czynszAvg: number;
					n: number;
					netMonthly: number;
					netYearly: number;
					netYieldPct: number | null;
				} | null;
				str: {
					nightlyAvg: number;
					occupancy: number;
					n: number;
					netMonthly: number;
					netYearly: number;
					netYieldPct: number | null;
				} | null;
			}
			const renderValuation = (v: OfferValuation): string => {
				const pl = (n: number) => Math.round(n).toLocaleString("pl-PL");
				const comp = (label: string, x: { avgM2: number; n: number } | null) =>
					x
						? `<div class="flex justify-between"><span class="text-gray-500">${label}</span><span>${pl(x.avgM2)} zł/m² <span class="text-gray-400">(${x.n})</span></span></div>`
						: "";
				const roi = (
					label: string,
					x: { n: number; netMonthly: number; netYieldPct: number | null },
					color: string,
				) =>
					x.netYieldPct != null
						? `<div class="mt-1 border-t pt-1">
								<div class="font-medium ${color}">${label} (netto)</div>
								<div class="text-gray-600">${pl(x.netMonthly)} zł/mies. netto → ROI <b>${x.netYieldPct.toFixed(1)}%</b>/rok</div>
								<div class="text-gray-400 text-xs">${x.n} porównań w okolicy</div>
							</div>`
						: "";
				return `<div class="mt-2 border-t pt-1 text-xs">
					<div class="font-medium">Wycena vs rynek</div>
					${v.comps.fairM2 != null ? `<div>godziwa: <b>${pl(v.comps.fairM2)} zł/m²</b>${v.overUnderPct != null ? ` · <span class="${v.rating?.tone ?? ""} font-medium">${v.rating?.label} ${v.overUnderPct > 0 ? "+" : ""}${v.overUnderPct}%</span>` : ""}</div>` : ""}
					${comp("ten budynek", v.comps.building)}
					${comp("okolica", v.comps.area)}
					${comp("RCN 1 km / 24 mies.", v.comps.rcn)}
					${v.lt ? roi("Najem długoterminowy", v.lt, "text-emerald-700") : ""}
					${v.str ? roi("Najem krótkoterminowy (szac.)", v.str, "text-rose-700") : ""}
				</div>`;
			};

			const showListingPopup = (e: mapboxgl.MapLayerMouseEvent) => {
				const feature = e.features?.[0] as { properties?: unknown } | undefined;
				const props = feature?.properties;
				if (!props) return;
				const listing = props as ApiListing;
				// Sale + LT-rental offers get a live valuation/ROI section
				// (fetched after the popup opens; STR popups stay as-is).
				const wantValuation =
					listing.offerType === "sale" ||
					listing.offerType === "long_term_rental";
				popupRef.current?.remove();
				const popup = new mapboxgl.Popup({
					offset: 16,
					closeButton: false,
					maxWidth: "320px",
				})
					.setLngLat(e.lngLat)
					.setHTML(
						wantValuation
							? `${popupHtml(listing)}<div id="popup-valuation" class="text-gray-400 text-xs">Liczenie wyceny…</div>`
							: popupHtml(listing),
					)
					.addTo(map);
				popupRef.current = popup;
				if (wantValuation) {
					void fetch(`/api/valuation/offer?id=${listing.id}`)
						.then((r) => r.json())
						.then((v: OfferValuation) => {
							if (popupRef.current !== popup) return; // stale popup
							const slot = document.getElementById("popup-valuation");
							if (slot) slot.outerHTML = renderValuation(v);
						})
						.catch(() => {
							const slot = document.getElementById("popup-valuation");
							if (slot && popupRef.current === popup) {
								slot.textContent = "Wycena niedostępna.";
							}
						});
				}
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
	// setData is safe even while the style is still streaming, so apply it
	// unconditionally. The old isStyleLoaded()/once("load") guard dead-locked
	// when the API resolved after "load" had already fired: the queued
	// callback never ran and the source stayed empty (no dots on the map).
	useEffect(() => {
		listingsRef.current = listings;
		const map = mapRef.current;
		if (!map) return;
		const src = map.getSource("listings");
		if (src && "setData" in src) {
			(src as mapboxgl.GeoJSONSource).setData(toGeoJson(listings));
		}
	}, [listings]);

	return <div ref={containerRef} className="h-full w-full" />;
}
