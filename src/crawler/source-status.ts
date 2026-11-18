/**
 * Canonical list of everything the data pipeline can report on, used by the
 * /sources status page and the /api/crawl-status endpoint.
 *
 * Deliberately a STATIC literal: these descriptors are read by SSR routes
 * (/api/crawl-status), so they must not import `sites/index.ts`. That module
 * pulls in the full adapter graph (crawlee/playwright), which crashes the
 * production server bundle (`__dirname` in ESM scope) when eagerly loaded.
 *
 * Three groups, so the status page can render the pipeline in the order data
 * actually flows:
 * - `portal` adapters (otodom, olx, airbnb, ...) — crawled by `refreshAll`
 * - `data` sources and reference layers: RCN/GUGiK transaction imports, the
 *   price indices, public investments, OSM building/road indices, terrain,
 *   EGiB parcels, and the datasets bundled at build time (`static: true`,
 *   never refreshed at runtime)
 * - `processing` phases that transform what is already stored: geocoding,
 *   Airbnb calendar and enrichment, building/parcel assignment, parcel
 *   enrichment, the derived listing columns and alert scoring
 */

/**
 * What a row on /sources represents. `layer` marks a reference dataset or a
 * derived map layer, `enrich` a pass that only adds attributes to stored rows.
 */
type SourceKind =
	| "portal"
	| "rcn"
	| "geocode"
	| "airbnb-calendar"
	| "public-investments"
	| "price-index"
	| "layer"
	| "enrich"
	| "scoring";

/** Coarse pipeline stage, used to group the status page. */
export type SourceGroup = "portal" | "data" | "processing";

export interface SourceDescriptor {
	id: string;
	name: string;
	kind: SourceKind;
	group: SourceGroup;
	/**
	 * Dataset bundled at build time (`src/data/**`): listed for transparency,
	 * never refreshed by a crawl or a scheduled task.
	 */
	static?: boolean;
	/**
	 * File or directory whose mtime is the layer's last refresh, for layers
	 * built by a manual job (`assign-buildings`, `build:osm-roads`, `build:dem`)
	 * instead of the hourly refresh. /api/crawl-status stats it, so the page
	 * can show a real timestamp instead of "never".
	 */
	freshnessFile?: string;
}

const PORTAL_SOURCES: SourceDescriptor[] = [
	{
		id: "otodom",
		name: "Otodom - Małopolska + Śląsk real estate for sale",
		kind: "portal",
		group: "portal",
	},
	{
		id: "otodom-rent",
		name: "Otodom - Małopolska + Śląsk long-term rentals",
		kind: "portal",
		group: "portal",
	},
	{
		id: "olx",
		name: "OLX - Małopolska + Śląsk real estate (sale)",
		kind: "portal",
		group: "portal",
	},
	{
		id: "olx-rent",
		name: "OLX - Małopolska + Śląsk long-term rentals",
		kind: "portal",
		group: "portal",
	},
	{
		id: "adresowo",
		name: "Adresowo - Małopolska + Śląsk direct-owner flats, houses and plots",
		kind: "portal",
		group: "portal",
	},
	{
		id: "gethome",
		name: "GetHome - Małopolska + Śląsk real estate for sale",
		kind: "portal",
		group: "portal",
	},
	{
		id: "sprzedajemy",
		name: "Sprzedajemy - Małopolska + Śląsk classifieds (flats, houses, plots)",
		kind: "portal",
		group: "portal",
	},
	{
		id: "tabelaofert",
		name: "TabelaOfert - Małopolska + Śląsk new developments (flats, houses, plots)",
		kind: "portal",
		group: "portal",
	},
	{
		id: "airbnb",
		name: "Airbnb - Małopolska + Śląsk short-term rentals",
		kind: "portal",
		group: "portal",
	},
	{
		id: "booking",
		name: "Booking - Małopolska + Śląsk short-term rentals",
		kind: "portal",
		group: "portal",
	},
	{
		id: "morizon",
		name: "Morizon - Małopolska + Śląsk real estate for sale",
		kind: "portal",
		group: "portal",
	},
	{
		id: "gratka",
		name: "Gratka - Małopolska + Śląsk real estate for sale",
		kind: "portal",
		group: "portal",
	},
	{
		id: "domiporta",
		name: "Domiporta - Małopolska + Śląsk real estate for sale",
		kind: "portal",
		group: "portal",
	},
	{
		id: "nieruchomosci-online",
		name: "Nieruchomosci-online - Małopolska + Śląsk real estate for sale",
		kind: "portal",
		group: "portal",
	},
	{
		id: "rynekpierwotny",
		name: "Rynekpierwotny - Małopolska + Śląsk new developments (flats + houses)",
		kind: "portal",
		group: "portal",
	},
	{
		id: "licytacje-komornik",
		name: "Licytacje komornicze · Małopolska + Śląsk (nieruchomości)",
		kind: "portal",
		group: "portal",
	},
	{
		id: "mapalicytacji",
		name: "Mapa Licytacji - gminne, AMW, KOWR, skarbowe, PKP, Orange, TAURON (Małopolska + Śląsk)",
		kind: "portal",
		group: "portal",
	},
	{
		id: "elicytacje-mf",
		name: "eLicytacje KAS - licytacje skarbowe (Małopolska + Śląsk)",
		kind: "portal",
		group: "portal",
	},
	{
		id: "investmap",
		name: "Investmap - Kraków + Katowice investments (flats + houses)",
		kind: "portal",
		group: "portal",
	},
	{
		// Kraków-only on purpose: budujesie.pl is a Kraków housing forum with
		// no Śląsk counterpart, so the source stays single-region while every
		// other portal covers both voivodeships.
		id: "budujesie",
		name: "BudujeSie - Krakow new housing investments (forum)",
		kind: "portal",
		group: "portal",
	},
];

const DATA_SOURCES: SourceDescriptor[] = [
	{
		id: "rcn-import",
		name: "RCN transactions (Rejestr Cen Nieruchomości)",
		kind: "rcn",
		group: "data",
	},
	{
		id: "gugik-import",
		name: "GUGiK RCN — transakcje per powiat (Małopolska + Śląsk)",
		kind: "rcn",
		group: "data",
	},
	{
		id: "price-indices",
		name: "Indeksy cen mieszkań (RCN, łańcuch)",
		kind: "price-index",
		group: "data",
	},
	{
		id: "finwire",
		name: "City flat-price index (finwire, RCN-derived) — Kraków + Katowice",
		kind: "price-index",
		group: "data",
	},
	{
		id: "public-investments",
		name: "Planned and completed public investments (Kraków My Maps)",
		kind: "public-investments",
		group: "data",
	},
	{
		id: "osm-index",
		name: "Indeks budynków OSM (Geofabrik)",
		kind: "layer",
		group: "data",
		freshnessFile: "data/osm/build-state.json",
	},
	{
		id: "osm-roads",
		name: "Indeks dróg OSM",
		kind: "layer",
		group: "data",
		freshnessFile: "data/osm/roads-build-state.json",
	},
	{
		id: "terrain",
		name: "Wysokość i spadek terenu (Copernicus DEM)",
		kind: "layer",
		group: "data",
		freshnessFile: "data/dem",
	},
	{
		id: "egib-import",
		name: "Działki EGiB (GUGiK WFS)",
		kind: "layer",
		group: "data",
	},
	{
		id: "railways",
		name: "Linie i stacje kolejowe (statyczne)",
		kind: "layer",
		group: "data",
		static: true,
	},
	{
		id: "uniqueness",
		name: "Unikalność lokalizacji (statyczne)",
		kind: "layer",
		group: "data",
		static: true,
	},
];

const PROCESSING_SOURCES: SourceDescriptor[] = [
	{
		id: "geocoding",
		name: "Geocoding (address → coordinates)",
		kind: "geocode",
		group: "processing",
	},
	{
		id: "airbnb-calendar",
		name: "Airbnb availability calendar",
		kind: "airbnb-calendar",
		group: "processing",
	},
	{
		id: "airbnb-enrich",
		name: "Wzbogacanie ofert Airbnb (łóżka, udogodnienia)",
		kind: "enrich",
		group: "processing",
	},
	{
		id: "building-assign",
		name: "Przypisanie ofert i transakcji do budynków (OSM)",
		kind: "layer",
		group: "processing",
	},
	{
		id: "parcel-assign",
		name: "Przypisanie działek (EGiB)",
		kind: "layer",
		group: "processing",
	},
	{
		id: "parcel-enrich",
		name: "Wzbogacanie działek (MPZP, drogi, teren)",
		kind: "layer",
		group: "processing",
	},
	{
		id: "listing-derived",
		name: "Kolumny pochodne ofert (widoczność, rodzaj, mapa)",
		kind: "layer",
		group: "processing",
	},
	{
		id: "listing-facts",
		name: "Ekstrakcja faktów z opisów (LLM: ogrzewanie, budynek, stan)",
		kind: "enrich",
		group: "processing",
	},
	{
		id: "scoring",
		name: "Alert scoring — top 5% offers (flats, houses, plots)",
		kind: "scoring",
		group: "processing",
	},
];

/** Every row /sources and /api/crawl-status can render, in pipeline order. */
export const sourceDescriptors: SourceDescriptor[] = [
	...PORTAL_SOURCES,
	...DATA_SOURCES,
	...PROCESSING_SOURCES,
];
