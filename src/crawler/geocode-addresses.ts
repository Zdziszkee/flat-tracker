import "dotenv/config";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, listings } from "#/db/schema";
import { buildStreetIndex, matchByAddress } from "./address-index.ts";
import { parseAddressFromText, plausibleAddress } from "./sites/address.ts";

/**
 * Geocode listings that have an address but no coordinates (portals that
 * hide them: morizon, gratka, domiporta, nieruchomosci-online).
 *
 * Strategy:
 *  1. Exact local match: look up the (street, housenumber) in the
 *     osm_buildings table (built from the Geofabrik extract) and use the
 *     building centroid directly — no network, exact building.
 *  2. Nominatim fallback: geocode "street, district, Kraków" (1 req/s,
 *     descriptive UA) for a street-level point. Results are validated:
 *     inside the Krakow bounds, a street/place/building class, and the
 *     street name must appear in the result. This rejects ad-speak
 *     ("Przytulne 27") that the old loose parser emitted.
 * Afterwards run `npm run assign-buildings` to anchor points to buildings.
 *
 * Usage: npm run geocode-addresses
 */

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

/** Krakow bounding box — the tracker only covers Krakow. */
const KRAKOW_BOUNDS = {
	minLng: 19.75,
	minLat: 49.95,
	maxLng: 20.25,
	maxLat: 50.15,
};

/** Nominatim result classes we trust as a geocoded point. */
const ACCEPTED_CLASSES = new Set(["place", "highway", "building", "landuse"]);

function normalizeWord(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Nominatim result validation. Returns null when the hit is outside
 * Krakow, is not a street/place/building, or its display name shares no
 * significant word with the queried street part.
 */
function validateNominatimHit(
	hit: { lat?: string; lon?: string; display_name?: string; class?: string },
	streetPart: string,
): { lat: number; lng: number } | null {
	if (!hit || !hit.lat || !hit.lon) return null;
	const lat = Number(hit.lat);
	const lng = Number(hit.lon);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (
		lat < KRAKOW_BOUNDS.minLat ||
		lat > KRAKOW_BOUNDS.maxLat ||
		lng < KRAKOW_BOUNDS.minLng ||
		lng > KRAKOW_BOUNDS.maxLng
	)
		return null;
	if (hit.class && !ACCEPTED_CLASSES.has(hit.class)) return null;

	// The result must share a significant word with the query, e.g.
	// "Sarego 8" -> display "... Józefa Sarego ..." contains "sarego".
	if (hit.display_name) {
		const wanted = normalizeWord(streetPart)
			.split(" ")
			.filter((w) => w.length >= 3);
		const shown = normalizeWord(hit.display_name);
		if (wanted.length > 0 && !wanted.some((w) => shown.includes(w)))
			return null;
	}
	return { lat, lng };
}

async function nominatimGeocode(
	address: string,
	streetPart: string,
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
		const j = (await res.json()) as Array<{
			lat?: string;
			lon?: string;
			display_name?: string;
			class?: string;
		}>;
		return validateNominatimHit(j[0], streetPart);
	} catch {
		return null;
	}
}

/** Resolve an osmId to a row in the `buildings` table (insert if missing). */
async function ensureBuildingByOsmId(
	osmId: number,
	lat: number,
	lng: number,
): Promise<number | null> {
	const existing = await db.query.buildings.findFirst({
		where: (row) => eq(row.osmId, osmId),
	});
	if (existing) return existing.id;

	const [row] = await db
		.insert(buildings)
		.values({ osmId, lat, lng })
		.onConflictDoNothing()
		.returning({ id: buildings.id });
	return row?.id ?? null;
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

		// 1. Exact local building match. Addresses are stored geocodable
		// ("Sarego 8, Bronowice, Kraków") — the street is always the first
		// comma segment. Parse only that segment so "os. Ruczaj-Zaborze"
		// in the district part is never mistaken for a street.
		const streetPart = l.address.split(",")[0].trim();
		const parsed = parseAddressFromText(streetPart);
		if (parsed) {
			const local = matchByAddress(
				streetIndex,
				parsed.street,
				parsed.number ?? null,
			);
			if (local) {
				const buildingId = await ensureBuildingByOsmId(
					local.osmId,
					local.lat,
					local.lng,
				);
				await db
					.update(listings)
					.set({ lat: local.lat, lng: local.lng, buildingId })
					.where(eq(listings.id, l.id));
				localHits++;
				continue;
			}
		}

		// 2. Nominatim street-level geocode, only for street parts that
		// plausibly carry an address (housenumber or explicit prefix).
		// Results are validated inside the request, so ad-speak like
		// "Przytulne 27" yields no point.
		if (!plausibleAddress(streetPart)) {
			misses++;
			continue;
		}
		const q = l.district
			? `${streetPart}, ${l.district}, Kraków`
			: `${streetPart}, Kraków`;
		const geo = await nominatimGeocode(q, streetPart);
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
