import { isNotNull } from "drizzle-orm";

import { db } from "#/db/index";
import { osmBuildings } from "#/db/schema";

/**
 * Address-based building matching against the local osm_buildings index.
 * RCN transactions carry street + housenumber from notarial records; OSM
 * buildings carry addr:street + addr:housenumber. An exact address match
 * is far more precise than a geo fallback, so it is tried first.
 */

export function normStreet(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Remove "ul./al./os./..." so "ul. Sarego" and "Sarego" key alike. */
const STREET_PREFIX_RE =
	/^(?:ul\.?|al\.?|aleja|os\.?|osiedle|pl\.?|plac|rynek|bulwar|rondo)\s+/iu;

export function stripStreetPrefix(s: string): string {
	return s.replace(STREET_PREFIX_RE, "").trim();
}

/** Split "ul. Jakuba Bojki 12" into {street, number}. */
export function parseAddress(address: string): {
	street: string;
	number?: string;
} {
	const m = address.match(/^(.+?)\s+(\d{1,4}[A-Za-z]?)$/);
	if (m) return { street: m[1].trim(), number: m[2] };
	return { street: address.trim() };
}

export interface StreetBuilding {
	osmId: number;
	number?: string;
	lat: number;
	lng: number;
	city?: string;
}

export interface StreetIndex {
	/** Full normalized street key -> buildings on that street. */
	byStreet: Map<string, StreetBuilding[]>;
	/** Individual significant word -> full street keys containing it. */
	byWord: Map<string, string[]>;
}

/** streetNorm -> buildings on that street. */
export async function buildStreetIndex(): Promise<StreetIndex> {
	const rows = await db
		.select({
			osmId: osmBuildings.osmId,
			address: osmBuildings.address,
			tags: osmBuildings.tags,
			centroidLat: osmBuildings.centroidLat,
			centroidLng: osmBuildings.centroidLng,
		})
		.from(osmBuildings)
		.where(isNotNull(osmBuildings.address));

	const byStreet = new Map<string, StreetBuilding[]>();
	const byWord = new Map<string, string[]>();
	for (const r of rows) {
		if (!r.address) continue;
		const { street, number } = parseAddress(r.address);
		const key = normStreet(stripStreetPrefix(street));
		if (!key) continue;
		let city: string | undefined;
		if (r.tags) {
			try {
				const tags = JSON.parse(r.tags) as Record<string, string>;
				city = tags["addr:city"] ?? tags["addr:place"];
			} catch {
				// Ignore malformed tags; city stays undefined.
			}
		}
		const list = byStreet.get(key) ?? [];
		list.push({
			osmId: r.osmId,
			number,
			lat: r.centroidLat,
			lng: r.centroidLng,
			city,
		});
		byStreet.set(key, list);

		// Register every significant word so a portal's single-word form
		// ("Meiera", "Kurozwęckiego", or even the first name "Dobiesława")
		// resolves to the full OSM name ("Księdza Józefa Meiera",
		// "Dobiesława Kurozwęckiego").
		for (const word of key.split(" ")) {
			if (word.length < 4) continue;
			const aliases = byWord.get(word) ?? [];
			if (!aliases.includes(key)) aliases.push(key);
			byWord.set(word, aliases);
		}
	}
	return { byStreet, byWord };
}

/**
 * Resolve a query street key to the full street keys it can mean. The exact
 * key (when present) is combined with any alias streets that share the
 * query's significant words, so a housenumber can still land on the full
 * name ("Józefa 70" -> "Księdza Józefa Meiera 70") without losing the
 * literal street.
 */
function streetKeys(index: StreetIndex, street: string | null): string[] {
	if (!street) return [];
	const key = normStreet(stripStreetPrefix(street));
	if (!key) return [];

	const candidates = new Set<string>();
	if (index.byStreet.has(key)) candidates.add(key);
	const queryWords = key.split(" ").filter((w) => w.length >= 4);
	for (const word of queryWords) {
		for (const full of index.byWord.get(word) ?? []) candidates.add(full);
	}
	if (queryWords.length === 0) return [...candidates];
	return [...candidates].filter((full) => {
		const fullWords = new Set(full.split(" "));
		return queryWords.every((w) => fullWords.has(w));
	});
}

function buildingsFor(
	index: StreetIndex,
	street: string | null,
): StreetBuilding[] {
	return streetKeys(index, street).flatMap(
		(key) => index.byStreet.get(key) ?? [],
	);
}

/**
 * Keep only buildings in the expected city (or buildings with no city).
 * An empty result means "no local match" so the caller falls back to
 * Nominatim rather than anchoring to the wrong town.
 */
function filterByCity(
	buildings: StreetBuilding[] | undefined,
	cityHint: string | null | undefined,
): StreetBuilding[] | undefined {
	if (!buildings || buildings.length === 0) return buildings;
	if (!cityHint) return buildings;
	const key = normStreet(cityHint);
	const withCity = buildings.filter((b) => b.city);
	const matches = withCity.filter((b) => b.city && normStreet(b.city) === key);
	if (matches.length > 0) return matches;
	// No building carries the expected city tag. Only fall back to city-less
	// buildings when the street has no city-tagged buildings at all; otherwise
	// a city-less OSM building must not anchor a query for another town.
	return withCity.length === 0 ? buildings : [];
}

/**
 * Exact street + housenumber match. Returns the building, or null.
 */
export function matchByAddress(
	index: StreetIndex,
	street: string | null,
	number: string | null,
	cityHint?: string | null,
): StreetBuilding | null {
	if (!street) return null;
	const buildings = filterByCity(buildingsFor(index, street), cityHint);
	if (!buildings || buildings.length === 0) return null;
	if (number) {
		const exact = buildings.find((b) => b.number === number);
		if (exact) return exact;
	}
	// Number-less query: return null so geo fallback handles it (a street
	// centroid would claim a random building's history).
	return null;
}

/**
 * Match a full address string like "ul. Jakuba Bojki 12". Returns the
 * exact building, or a street centroid with no building (for geocoding).
 */
export function matchAddressString(
	index: StreetIndex,
	address: string,
	cityHint?: string | null,
): { lat: number; lng: number; building: StreetBuilding | null } | null {
	const { street, number } = parseAddress(address);
	const buildings = filterByCity(buildingsFor(index, street), cityHint);
	if (!buildings || buildings.length === 0) return null;

	if (number) {
		const exact = buildings.find((b) => b.number === number);
		if (exact) return { lat: exact.lat, lng: exact.lng, building: exact };
	}
	// Street-only: centroid of the street's buildings, no building claim.
	const lat = buildings.reduce((s, b) => s + b.lat, 0) / buildings.length;
	const lng = buildings.reduce((s, b) => s + b.lng, 0) / buildings.length;
	return { lat, lng, building: null };
}

/** cityNorm -> centroid of that city's buildings (offline fallback). */
export async function buildCityCentroids(): Promise<
	Map<string, { lat: number; lng: number }>
> {
	const rows = await db
		.select({
			tags: osmBuildings.tags,
			centroidLat: osmBuildings.centroidLat,
			centroidLng: osmBuildings.centroidLng,
		})
		.from(osmBuildings)
		.where(isNotNull(osmBuildings.tags));

	const sums = new Map<string, { lat: number; lng: number; n: number }>();
	for (const r of rows) {
		let city: string | undefined;
		if (r.tags) {
			try {
				const tags = JSON.parse(r.tags) as Record<string, string>;
				city = tags["addr:city"] ?? tags["addr:place"];
			} catch {
				city = undefined;
			}
		}
		if (!city) continue;
		const key = normStreet(city);
		if (!key) continue;
		const s = sums.get(key) ?? { lat: 0, lng: 0, n: 0 };
		s.lat += r.centroidLat;
		s.lng += r.centroidLng;
		s.n += 1;
		sums.set(key, s);
	}
	return new Map(
		[...sums.entries()].map(([k, s]) => [
			k,
			{ lat: s.lat / s.n, lng: s.lng / s.n },
		]),
	);
}
