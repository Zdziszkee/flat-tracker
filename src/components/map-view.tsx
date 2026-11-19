import mapboxgl from "mapbox-gl";
import { useEffect, useMemo, useRef } from "react";

import "mapbox-gl/dist/mapbox-gl.css";

import { useOccupancy } from "#/hooks/use-occupancy";
import type { KindFilter } from "#/lib/listing-features";
import type { OccupancyCell } from "#/types/occupancy";
import { addBuildingLayersWhenZoomed } from "./map/buildings-layer";
import { MAP_DARK_CSS } from "./map/chrome";
import {
	DETAIL_3D_MINZOOM,
	MAP_MAX_BOUNDS,
	TOKEN,
	TRACKED_REGION_BOUNDS,
	TRACKED_REGION_CENTER,
} from "./map/constants";
import { MapLegend } from "./map/legend";
import {
	addListingsLayers,
	createListingsFeed,
	type ListingFilters,
} from "./map/listings-layer";
import {
	addOccupancyLayer,
	setOccupancyData,
	setOccupancyVisible,
} from "./map/occupancy-layer";
import { createParcelsLayer } from "./map/parcels-layer";
import {
	addPublicInvestmentLayer,
	setPublicInvestmentsVisible,
} from "./map/public-investments-layer";
import { addRailwayLayers, setRailwaysVisible } from "./map/railways-layer";
import { pruneBadTileCache, resetTileCache } from "./map/tile-cache";
import type { PopupRef } from "./map/types";

/**
 * Map screen: a Mapbox Standard canvas with the tracker's own overlays (RCN
 * buildings, listings, parcels, railways, public investments, STR
 * occupancy). Each overlay lives in its own module under `./map/`; this file
 * owns the map lifecycle and the toggle effects.
 */
export default function MapView({
	source,
	days,
	offerType,
	kind,
	showParcels,
	showRailways,
	showOccupancy,
	showInvestments,
	occupancySource,
	occupancyMonth,
}: {
	source: string;
	days: 0 | 1 | 7 | 30;
	offerType: OfferTypeFilter;
	kind: KindFilter;
	showParcels: boolean;
	showRailways: boolean;
	showOccupancy: boolean;
	showInvestments: boolean;
	occupancySource: "airbnb" | "booking" | "all";
	occupancyMonth: string;
}) {
	const { data: occupancyData } = useOccupancy(
		occupancySource,
		occupancyMonth,
		showOccupancy,
	);
	const occupancyCells = useMemo(
		() => occupancyData?.cells ?? [],
		[occupancyData],
	);

	if (!TOKEN) {
		return (
			<div className="flex h-full items-center justify-center p-6 text-center text-sm text-destructive-foreground">
				Brak klucza VITE_MAPBOX_TOKEN w .env.local — mapa nie działa bez tokena
				Mapbox.
			</div>
		);
	}

	return (
		<div className="relative h-full w-full">
			<style>{MAP_DARK_CSS}</style>
			<MapCanvas
				source={source}
				days={days}
				offerType={offerType}
				kind={kind}
				showParcels={showParcels}
				showRailways={showRailways}
				showOccupancy={showOccupancy}
				showInvestments={showInvestments}
				occupancy={occupancyCells}
			/>

			<MapLegend showParcels={showParcels} showOccupancy={showOccupancy} />
		</div>
	);
}

function MapCanvas({
	source,
	days,
	offerType,
	kind,
	showParcels,
	showRailways,
	showOccupancy,
	showInvestments,
	occupancy,
}: {
	source: string;
	days: 0 | 1 | 7 | 30;
	offerType: OfferTypeFilter;
	kind: KindFilter;
	showParcels: boolean;
	showRailways: boolean;
	showOccupancy: boolean;
	showInvestments: boolean;
	occupancy: OccupancyCell[];
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<mapboxgl.Map | null>(null);
	const popupRef = useRef<PopupRef["current"]>(null);
	/** Latest filters, read from the map callbacks that outlive renders. */
	const filtersRef = useRef<ListingFilters>({ source, days, offerType, kind });
	filtersRef.current = { source, days, offerType, kind };
	// Read by the layer creation inside the map callbacks, which outlive renders.
	const showParcelsRef = useRef(showParcels);
	const showInvestmentsRef = useRef(showInvestments);
	const showOccupancyRef = useRef(showOccupancy);
	// Latest occupancy snapshot, set by the effect below.
	const occupancyRef = useRef(occupancy);
	// Controllers created on the mount effect (the map must exist first).
	const feedRef = useRef<ReturnType<typeof createListingsFeed> | null>(null);
	const parcelsRef = useRef<ReturnType<typeof createParcelsLayer> | null>(null);

	// Create the map once; every overlay below is added on style/load and then
	// kept current through the effects at the bottom of this component.
	useEffect(() => {
		if (!containerRef.current || mapRef.current) return;

		const map = new mapboxgl.Map({
			container: containerRef.current,
			// Mapbox Standard core style: colorful basemap with native 3D
			// landmarks, trees, procedural buildings, dynamic light and
			// atmosphere sky. Our RCN feature-state coloring hooks into the
			// style's own select/highlight states (see below).
			style: "mapbox://styles/mapbox/standard",
			// Both voivodeships, fitted below: the tracker covers Małopolska and
			// Śląsk, and a Kraków-only default hid half of the data. The 3D
			// landmarks/trees stay off until DETAIL_3D_MINZOOM for the first-paint
			// reason documented there.
			center: TRACKED_REGION_CENTER,
			zoom: 8.5,
			// Flat overview: `fitBounds` does not account for pitch, and a
			// tilted fit silently cropped ~35% of the latitude span (measured:
			// 49.56-50.85 instead of 49.1-51.07), losing both Częstochowa and
			// the Tatra powiaty. The user can tilt; the region view stays complete.
			pitch: 0,
			bearing: -20,
			maxBounds: MAP_MAX_BOUNDS,
			config: {
				// Dusk from the first frame: the dark UI must not open on a
				// bright daytime basemap (the load handler re-asserts it).
				basemap: {
					lightPreset: "dusk",
					show3dLandmarks: false,
					show3dTrees: false,
				},
			},
			accessToken: TOKEN,
			// Keep the frame buffer for compositors/screenshots: without it,
			// capture paths (headless tools, remote-desktop bridges) show a
			// permanently blank canvas even while the map renders fine.
			preserveDrawingBuffer: true,
		});
		mapRef.current = map;
		// Frame every tracked region, whatever the viewport size (a fixed zoom
		// would cut off either Częstochowa or Zakopane on a narrow screen).
		// Right after construction, so the first painted frame is already the
		// final one.
		try {
			map.fitBounds(TRACKED_REGION_BOUNDS, {
				padding: 24,
				duration: 0,
			});
		} catch {
			// fitBounds is available in every mapbox-gl version we support; the
			// zoom/center above still frame both regions if it ever throws.
		}
		// Debug hook for browser-console inspection.
		(window as unknown as { __map?: mapboxgl.Map }).__map = map;
		// Basemap 3D detail (landmarks, trees) follows the zoom: off across
		// the two-voivodeship overview, on from DETAIL_3D_MINZOOM (see there).
		const syncDetail3d = () => {
			const detailed = map.getZoom() >= DETAIL_3D_MINZOOM;
			for (const prop of ["show3dLandmarks", "show3dTrees"]) {
				try {
					map.setConfigProperty("basemap", prop, detailed);
				} catch {
					// Style version without that property: nothing to sync.
				}
			}
		};
		map.addControl(
			new mapboxgl.NavigationControl({ visualizePitch: true }),
			"top-right",
		);

		// Mapbox GL caches 404 tile bodies and later parses the cached JSON as
		// a vector tile ("Expected varint..."). Drop those entries after load
		// and interactions; a parse error means one slipped through, so reset
		// the tile cache and let the map refetch.
		map.on("load", () => pruneBadTileCache(true));
		map.on("idle", () => pruneBadTileCache());
		map.on("error", (event) => {
			const message = event.error?.message ?? "";
			if (message.includes("Expected varint not more than 10 bytes")) {
				resetTileCache();
			}
		});

		// Viewport-limited listing feed. The source does not exist until the
		// load handler adds it, so early syncs are a no-op.
		const feed = createListingsFeed(map, () => filtersRef.current);
		feedRef.current = feed;

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
			// Dusk light matches the dark app chrome while keeping the
			// Standard palette readable; night is the fallback for style
			// versions without the dusk preset.
			try {
				map.setConfigProperty("basemap", "lightPreset", "dusk");
			} catch {
				try {
					map.setConfigProperty("basemap", "lightPreset", "night");
				} catch {
					// Older style versions ignore config presets.
				}
			}
			// The constructor config already set the 3D detail off for the
			// overview zoom; keep it in sync as the user zooms in and out.
			syncDetail3d();
			map.on("zoomend", syncDetail3d);

			addBuildingLayersWhenZoomed(map, popupRef);
			addRailwayLayers(map);
			addPublicInvestmentLayer(map, showInvestmentsRef.current);
			addListingsLayers(map, popupRef);
			// First viewport request; moveend keeps it current afterwards.
			feed.sync();

			// Stations belong ABOVE the dense price circles (a station under ten
			// pins is invisible) but below the komornik/budujesie symbols.
			if (map.getLayer("komornik-listings")) {
				if (map.getLayer("railway-station")) {
					map.moveLayer("railway-station", "komornik-listings");
				}
				if (map.getLayer("railway-station-label")) {
					map.moveLayer("railway-station-label", "komornik-listings");
				}
			}

			addOccupancyLayer(
				map,
				occupancyRef.current,
				showOccupancyRef.current,
				popupRef,
			);
			// Parcels go on top of the occupancy heat layer, as before.
			parcelsRef.current = createParcelsLayer(
				map,
				popupRef,
				showParcelsRef.current,
			);
		});

		return () => {
			feed.dispose();
			feedRef.current = null;
			parcelsRef.current?.dispose();
			parcelsRef.current = null;
			map.remove();
			mapRef.current = null;
			popupRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// "Granice działek" toggle: hide/show at once, and refresh when switched
	// on (the layer is zoom-gated, so turning it on while zoomed out simply
	// keeps it hidden until the camera is close enough).
	useEffect(() => {
		showParcelsRef.current = showParcels;
		parcelsRef.current?.setVisible(showParcels);
	}, [showParcels]);

	// "Kolej" visibility toggle (lines + stations; data is static, only the
	// layers flip).
	useEffect(() => {
		const map = mapRef.current;
		if (!map) return;
		setRailwaysVisible(map, showRailways);
	}, [showRailways]);

	// Public-investment layer visibility (data is static for the session).
	useEffect(() => {
		showInvestmentsRef.current = showInvestments;
		const map = mapRef.current;
		if (!map) return;
		setPublicInvestmentsVisible(map, showInvestments);
	}, [showInvestments]);

	// Occupancy heatmap visibility toggle. Data updates live in the effect
	// below — kept separate so flipping visibility never re-serializes or
	// re-pushes the payload into the source.
	useEffect(() => {
		showOccupancyRef.current = showOccupancy;
		const map = mapRef.current;
		if (!map) return;
		setOccupancyVisible(map, showOccupancy);
	}, [showOccupancy]);

	// Occupancy data updates: push new GeoJSON when the cells change.
	useEffect(() => {
		occupancyRef.current = occupancy;
		const map = mapRef.current;
		if (!map) return;
		setOccupancyData(map, occupancy);
	}, [occupancy]);

	// Filter changes refetch the current viewport immediately, bypassing the
	// move-end debounce. The old full feed filtered 45k rows and re-serialized
	// the whole GeoJSON on the main thread for every filter change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the filter props are the trigger; the feed reads them from filtersRef.
	useEffect(() => {
		feedRef.current?.sync();
	}, [source, days, offerType, kind]);

	return <div ref={containerRef} className="h-full w-full" />;
}
