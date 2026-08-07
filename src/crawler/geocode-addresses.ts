import "dotenv/config";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, listings } from "#/db/schema";
import { buildStreetIndex, matchAddressString } from "./address-index.ts";
import { plausibleAddress } from "./sites/address.ts";

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
		const local = matchAddressString(streetIndex, l.address);
		if (local) {
			const buildingId = local.building
				? await ensureBuildingByOsmId(
						local.building.osmId,
						local.building.lat,
						local.building.lng,
					)
				: null;
			await db
				.update(listings)
				.set({
					lat: local.lat,
					lng: local.lng,
					...(buildingId ? { buildingId } : {}),
				})
				.where(eq(listings.id, l.id));
			localHits++;
			continue;
		}

		// 2. Nominatim street-level geocode. Only for plausible addresses
		// (housenumber or explicit street prefix) — ad-speak like
		// "Oferujemy, Kraków" would otherwise geocode to a random point.
		if (!plausibleAddress(l.address)) {
			misses++;
			continue;
		}
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
