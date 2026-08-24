import { adapters } from "./sites/index.ts";

/**
 * Canonical list of everything the data pipeline can report on, used by the
 * /sources status page and the /api/crawl-status endpoint.
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

/** Demo fixtures excluded from the live pipeline (see refresh.ts). */
const DEMO_SOURCES = new Set(["quotes", "books"]);

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
	...adapters
		.filter((a) => !DEMO_SOURCES.has(a.id))
		.map((a) => ({ id: a.id, name: a.name, kind: "portal" as const })),
	...PIPELINE_SOURCES,
];

/** Human name for a source id, falling back to the raw id. */
export function sourceName(id: string): string {
	return sourceDescriptors.find((s) => s.id === id)?.name ?? id;
}
