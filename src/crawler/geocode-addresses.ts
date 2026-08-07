import "dotenv/config";

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { listings, osmBuildings } from "#/db/schema";

/**
 * Geocode listings that have an address but no coordinates (portals that
 * hide them: morizon, gratka, domiporta, nieruchomosci-online).
 *
 * Strategy:
 *  1. Exact local match: look up the (street, housenumber) in the
 *     osm_buildings table (built from the Geofabrik extract) and use the
 *     building centroid directly — no network, exact building.
 *  2. Nominatim fallback: geocode "street, district, Kraków" (1 req/s,
 *     descriptive UA) for a street-level point.
 * Afterwards run `npm run assign-buildings` to anchor points to buildings.
 *
 * Usage: npm run geocode-addresses
 */

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

function normStreet(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Split "ul. Jakuba Bojki 12" into {street, number}. */
function parseAddress(address: string): { street: string; number?: string } {
	const m = address.match(/^(.+?)\s+(\d{1,4}[A-Za-z]?)$/);
	if (m) return { street: m[1].trim(), number: m[2] };
	return { street: address.trim() };
}

interface StreetBuilding {
	number?: string;
	lat: number;
	lng: number;
	id: number;
}

/** streetNorm -> buildings on that street. */
async function buildStreetIndex(): Promise<Map<string, StreetBuilding[]>> {
	const rows = await db
		.select({
			id: osmBuildings.id,
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
		const key = normStreet(street);
		if (!key) continue;
		const list = index.get(key) ?? [];
		list.push({ number, lat: r.centroidLat, lng: r.centroidLng, id: r.id });
		index.set(key, list);
	}
	console.log(`street index: ${index.size} streets, ${rows.length} buildings`);
	return index;
}

function localMatch(
	index: Map<string, StreetBuilding[]>,
	address: string,
): { lat: number; lng: number; buildingId: number | null } | null {
	const { street, number } = parseAddress(address);
	const buildings = index.get(normStreet(street));
	if (!buildings || buildings.length === 0) return null;

	// Exact street+housenumber -> that building (its RCN history is valid).
	if (number) {
		const exact = buildings.find((b) => b.number === number);
		if (exact) return { lat: exact.lat, lng: exact.lng, buildingId: exact.id };
	}
	// Street-only: centroid of the street's buildings; no buildingId, so the
	// map shows a street-level point without claiming a specific building's
	// transaction history.
	const lat = buildings.reduce((s, b) => s + b.lat, 0) / buildings.length;
	const lng = buildings.reduce((s, b) => s + b.lng, 0) / buildings.length;
	return { lat, lng, buildingId: null };
}

async function nominatimGeocode(
	address: string,
): Promise<{ lat: number; lng: number } | null> {
	const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1`;
	try {
		const res = await fetch(url, {
			headers: {
				"user-agent": "flat-tracker/0.1 (personal project)",
				accept: "application/json",
			},
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const j = (await res.json()) as Array<{ lat?: string; lon?: string }>;
		const hit = j[0];
		if (!hit || !hit.lat || !hit.lon) return null;
		const lat = Number(hit.lat);
		const lng = Number(hit.lon);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		return { lat, lng };
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const unlocated = await db
		.select({
			id: listings.id,
			address: listings.address,
			district: listings.district,
		})
		.from(listings)
		.where(and(isNull(listings.lat), isNotNull(listings.address)));

	console.log(`listings to geocode: ${unlocated.length}`);
	const streetIndex = await buildStreetIndex();
	let localHits = 0;
	let nomHits = 0;
	let misses = 0;

	for (let i = 0; i < unlocated.length; i++) {
		const l = unlocated[i];
		if (!l.address) continue;

		// 1. Exact local building match.
		const local = localMatch(streetIndex, l.address);
		if (local) {
			await db
				.update(listings)
				.set({
					lat: local.lat,
					lng: local.lng,
					buildingId: local.buildingId,
				})
				.where(eq(listings.id, l.id));
			localHits++;
			continue;
		}

		// 2. Nominatim street-level geocode.
		const q = l.district
			? `${l.address}, ${l.district}, Kraków`
			: `${l.address}, Kraków`;
		const geo = await nominatimGeocode(q);
		if (geo) {
			await db
				.update(listings)
				.set({ lat: geo.lat, lng: geo.lng })
				.where(eq(listings.id, l.id));
			nomHits++;
		} else {
			misses++;
		}

		if ((i + 1) % 50 === 0) {
			console.log(
				`  ${i + 1}/${unlocated.length}: local=${localHits} nominatim=${nomHits} misses=${misses}`,
			);
		}
		// Nominatim requires ~1 req/s.
		await new Promise((r) => setTimeout(r, 1050));
	}

	console.log(
		`done: local=${localHits} nominatim=${nomHits} misses=${misses} (of ${unlocated.length})`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
