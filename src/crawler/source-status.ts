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

export type SourceKind = "portal" | "rcn" | "geocode" | "airbnb-calendar";

export interface SourceDescriptor {
	id: string;
	name: string;
	kind: SourceKind;
}

const PORTAL_SOURCES: SourceDescriptor[] = [
	{ id: "otodom", name: "Otodom - Krakow flats for sale", kind: "portal" },
	{ id: "olx", name: "OLX - Małopolska real estate (sale)", kind: "portal" },
	{
		id: "olx-rent",
		name: "OLX - Małopolska long-term rentals",
		kind: "portal",
	},
	{
		id: "airbnb",
		name: "Airbnb - Małopolska short-term rentals",
		kind: "portal",
	},
	{
		id: "booking",
		name: "Booking - Małopolska short-term rentals",
		kind: "portal",
	},
	{ id: "morizon", name: "Morizon - Krakow flats for sale", kind: "portal" },
	{ id: "gratka", name: "Gratka - Krakow flats for sale", kind: "portal" },
	{
		id: "domiporta",
		name: "Domiporta - Krakow flats for sale",
		kind: "portal",
	},
	{
		id: "nieruchomosci-online",
		name: "Nieruchomosci-online - Krakow flats for sale",
		kind: "portal",
	},
	{
		id: "rynekpierwotny",
		name: "Rynekpierwotny - Krakow new developments",
		kind: "portal",
	},
	{
		id: "licytacje-komornik",
		name: "Licytacje komornicze · Małopolska (nieruchomości)",
		kind: "portal",
	},
	{
		id: "investmap",
		name: "Investmap - Krakow investments with flats",
		kind: "portal",
	},
	{
		id: "skaleczna",
		name: "Skałeczna (Koneser Group) - Kazimierz",
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

/** Human name for a source id, falling back to the raw id. */
export function sourceName(id: string): string {
	return sourceDescriptors.find((s) => s.id === id)?.name ?? id;
}
