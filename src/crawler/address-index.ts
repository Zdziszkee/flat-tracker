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
}

/** streetNorm -> buildings on that street. */
export async function buildStreetIndex(): Promise<
	Map<string, StreetBuilding[]>
> {
	const rows = await db
		.select({
			osmId: osmBuildings.osmId,
			address: osmBuildings.address,
			centroidLat: osmBuildings.centroidLat,
			centroidLng: osmBuildings.centroidLng,
		})
		.from(osmBuildings)
		.where(isNotNull(osmBuildings.address));

	const index = new Map<string, StreetBuilding[]>();
	for (const r of rows) {
		if (!r.address) continue;
		const { street, number } = parseAddress(r.address);
		const key = normStreet(stripStreetPrefix(street));
		if (!key) continue;
		const list = index.get(key) ?? [];
		list.push({
			osmId: r.osmId,
			number,
			lat: r.centroidLat,
			lng: r.centroidLng,
		});
		index.set(key, list);
	}
	return index;
}

/**
 * Exact street + housenumber match. Returns the building, or null.
 */
export function matchByAddress(
	index: Map<string, StreetBuilding[]>,
	street: string | null,
	number: string | null,
): StreetBuilding | null {
	if (!street) return null;
	const buildings = index.get(normStreet(street));
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
	index: Map<string, StreetBuilding[]>,
	address: string,
): { lat: number; lng: number; building: StreetBuilding | null } | null {
	const { street, number } = parseAddress(address);
	const buildings = index.get(normStreet(street));
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
