/**
 * Canonical list of everything the data pipeline can report on, used by the
 * /sources status page and the /api/crawl-status endpoint.
 *
 * Deliberately a STATIC literal: these descriptors are read by SSR routes
 * (/api/crawl-status), so they must not import `sites/index.ts`. That module
 * pulls in the full adapter graph (crawlee/playwright), which crashes the
 * production server bundle (`__dirname` in ESM scope) when eagerly loaded.
 *
 * Two groups:
 * - portal adapters (otodom, olx, airbnb, ...) — crawled by `refreshAll`
 * - pipeline steps that also persist data but are not portal crawls:
 *   RCN transaction import, address geocoding, and the Airbnb availability
 *   calendar (which runs on its own daily task, not inside `refreshAll`).
 */

type SourceKind = "portal" | "rcn" | "geocode" | "airbnb-calendar";

export interface SourceDescriptor {
	id: string;
	name: string;
	kind: SourceKind;
}

const PORTAL_SOURCES: SourceDescriptor[] = [
	{
		id: "otodom",
		name: "Otodom - Małopolska + Śląsk real estate for sale",
		kind: "portal",
	},
	{
		id: "otodom-rent",
		name: "Otodom - Małopolska + Śląsk long-term rentals",
		kind: "portal",
	},
	{
		id: "olx",
		name: "OLX - Małopolska + Śląsk real estate (sale)",
		kind: "portal",
	},
	{
		id: "olx-rent",
		name: "OLX - Małopolska + Śląsk long-term rentals",
		kind: "portal",
	},
	{
		id: "adresowo",
		name: "Adresowo - Małopolska + Śląsk direct-owner flats, houses and plots",
		kind: "portal",
	},
	{
		id: "gethome",
		name: "GetHome - Małopolska + Śląsk real estate for sale",
		kind: "portal",
	},
	{
		id: "sprzedajemy",
		name: "Sprzedajemy - Małopolska + Śląsk classifieds (flats, houses, plots)",
		kind: "portal",
	},
	{
		id: "tabelaofert",
		name: "TabelaOfert - Małopolska + Śląsk new developments (flats, houses, plots)",
		kind: "portal",
	},
	{
		id: "airbnb",
		name: "Airbnb - Małopolska + Śląsk short-term rentals",
		kind: "portal",
	},
	{
		id: "booking",
		name: "Booking - Małopolska + Śląsk short-term rentals",
		kind: "portal",
	},
	{
		id: "morizon",
		name: "Morizon - Małopolska + Śląsk real estate for sale",
		kind: "portal",
	},
	{
		id: "gratka",
		name: "Gratka - Małopolska + Śląsk real estate for sale",
		kind: "portal",
	},
	{
		id: "domiporta",
		name: "Domiporta - Małopolska + Śląsk real estate for sale",
		kind: "portal",
	},
	{
		id: "nieruchomosci-online",
		name: "Nieruchomosci-online - Małopolska + Śląsk real estate for sale",
		kind: "portal",
	},
	{
		id: "rynekpierwotny",
		name: "Rynekpierwotny - Małopolska + Śląsk new developments (flats + houses)",
		kind: "portal",
	},
	{
		id: "licytacje-komornik",
		name: "Licytacje komornicze · Małopolska + Śląsk (nieruchomości)",
		kind: "portal",
	},
	{
		id: "mapalicytacji",
		name: "Mapa Licytacji - gminne, AMW, KOWR, skarbowe, PKP, Orange, TAURON (Małopolska + Śląsk)",
		kind: "portal",
	},
	{
		id: "investmap",
		name: "Investmap - Kraków + Katowice investments (flats + houses)",
		kind: "portal",
	},
	{
		// Kraków-only on purpose: budujesie.pl is a Kraków housing forum with
		// no Śląsk counterpart, so the source stays single-region while every
		// other portal covers both voivodeships.
		id: "budujesie",
		name: "BudujeSie - Krakow new housing investments (forum)",
		kind: "portal",
	},
];

const PIPELINE_SOURCES: SourceDescriptor[] = [
	{
		id: "rcn-import",
		name: "RCN transactions (Rejestr Cen Nieruchomości)",
		kind: "rcn",
	},
	{
		id: "geocoding",
		name: "Geocoding (address → coordinates)",
		kind: "geocode",
	},
	{
		id: "airbnb-calendar",
		name: "Airbnb availability calendar",
		kind: "airbnb-calendar",
	},
];

export const sourceDescriptors: SourceDescriptor[] = [
	...PORTAL_SOURCES,
	...PIPELINE_SOURCES,
];
