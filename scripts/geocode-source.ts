import { and, eq, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { buildings, listings } from "#/db/schema";
import {
	buildStreetIndex,
	matchAddressString,
	matchByAddress,
} from "../src/crawler/address-index.ts";
import { parseAddressFromText } from "../src/crawler/sites/address.ts";

/**
 * Throwaway: anchor listings of one source via the local OSM building
 * index (exact street+housenumber -> building, else street centroid,
 * then Nominatim). Usage: npx tsx scripts/geocode-source.ts <source>
 * The general `npm run geocode-addresses` covers everything else but
 * walks thousands of old rows at 1 req/s.
 */
async function main(): Promise<void> {
	const source = process.argv[2];
	if (!source) {
		console.error("usage: npx tsx scripts/geocode-source.ts <source>");
		process.exitCode = 1;
		return;
	}
	const rows = await db
		.select({ id: listings.id, address: listings.address })
		.from(listings)
		.where(and(eq(listings.source, source), isNull(listings.lat)));
	console.log(`unlocated ${source} rows: ${rows.length}`);

	const index = await buildStreetIndex();
	let local = 0;
	let centroid = 0;
	let miss = 0;

	for (const l of rows) {
		if (!l.address) {
			miss++;
			continue;
		}
		// "Władysława Żeleńskiego 84/14, 31-353, Kraków" -> street part only.
		const segment = l.address.split(",")[0].trim();
		const parsed = parseAddressFromText(segment);
		if (!parsed) {
			miss++;
			continue;
		}
		// OSM stores the housenumber without the flat suffix ("84", not "84/14").
		const number = parsed.number?.split("/")[0] ?? null;
		const exact = matchByAddress(index, parsed.street, number);
		if (exact) {
			const existing = await db.query.buildings.findFirst({
				where: (row) => eq(row.osmId, exact.osmId),
			});
			const buildingId =
				existing ??
				(
					await db
						.insert(buildings)
						.values({
							osmId: exact.osmId,
							lat: exact.lat,
							lng: exact.lng,
						})
						.onConflictDoNothing()
						.returning({ id: buildings.id })
				)[0];
			await db
				.update(listings)
				.set({
					lat: exact.lat,
					lng: exact.lng,
					buildingId: buildingId?.id ?? null,
				})
				.where(eq(listings.id, l.id));
			local++;
			continue;
		}
		const streetPoint = matchAddressString(index, segment);
		if (streetPoint) {
			await db
				.update(listings)
				.set({ lat: streetPoint.lat, lng: streetPoint.lng })
				.where(eq(listings.id, l.id));
			centroid++;
			continue;
		}
		// Nominatim fallback (13 rows max, ~1 s each).
		const geo = await nominatim(segment);
		if (geo) {
			await db
				.update(listings)
				.set({ lat: geo.lat, lng: geo.lng })
				.where(eq(listings.id, l.id));
			centroid++;
			continue;
		}
		miss++;
	}

	console.log(`done: exact=${local} street-centroid=${centroid} miss=${miss}`);
}

const KRAKOW_BOUNDS = {
	minLng: 19.75,
	minLat: 49.95,
	maxLng: 20.25,
	maxLat: 50.15,
};

async function nominatim(
	address: string,
): Promise<{ lat: number; lng: number } | null> {
	const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(`${address}, Kraków`)}&format=json&limit=1`;
	try {
		const res = await fetch(url, {
			headers: { "user-agent": "flat-tracker/0.1 (personal project)" },
		});
		if (!res.ok) return null;
		const hits = (await res.json()) as Array<{
			lat?: string;
			lon?: string;
			class?: string;
		}>;
		const hit = hits[0];
		if (!hit?.lat || !hit.lon) return null;
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
		return { lat, lng };
	} catch {
		return null;
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
