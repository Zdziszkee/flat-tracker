import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { buildings, listings } from "#/db/schema";
import { buildStreetIndex, matchByAddress } from "./address-index.ts";
import { parseAddressFromText, plausibleAddress } from "./sites/address.ts";

/**
 * Geocode listings that have no coordinates yet, so they land on the map:
 *
 * 1. Address present -> local OSM building index (exact street+housenumber
 *    -> building centroid, street-only -> street centroid). No network.
 * 2. Address missing -> extract "Street 12" from the TITLE (otodom/olx ad
 *    speak, komornik notices, ...). The extracted address is persisted so
 *    later runs skip straight to the local index.
 * 3. Street found but not in the local index -> Nominatim (1 req/s,
 *    validated to Krakow, per-address result cache).
 *
 * `nominatimLimit` bounds external calls for the hourly refresh; the CLI
 * (`npm run geocode-addresses`) passes no limit to drain the backlog.
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

/** Demo adapters whose fixtures must never be geocoded. */
const DEMO_SOURCES = new Set(["books", "quotes"]);

function normalizeWord(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

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

export interface GeocodeReport {
	total: number;
	localHits: number;
	nomHits: number;
	titleExtracted: number;
	misses: number;
}

export async function geocodeUnlocatedListings(
	opts: {
		/** Max Nominatim requests this run (undefined = unlimited). */
		nominatimLimit?: number;
	} = {},
): Promise<GeocodeReport> {
	const rows = db
		.select({
			id: listings.id,
			source: listings.source,
			title: listings.title,
			address: listings.address,
			district: listings.district,
		})
		.from(listings)
		.where(and(isNull(listings.lat), isNotNull(listings.title)))
		.all()
		.filter((row) => !DEMO_SOURCES.has(row.source));

	const report: GeocodeReport = {
		total: rows.length,
		localHits: 0,
		nomHits: 0,
		titleExtracted: 0,
		misses: 0,
	};
	if (rows.length === 0) return report;

	const streetIndex = await buildStreetIndex();
	// Nominatim results are cached per query — morizon/gratka carry the
	// same offers, so one address should cost one request.
	const nomCache = new Map<string, { lat: number; lng: number } | null>();
	let nomBudget = opts.nominatimLimit ?? Number.POSITIVE_INFINITY;

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		// 1. The street part is always the first comma segment of a stored
		//    address; fall back to parsing it out of the title.
		let streetPart = row.address?.split(",")[0]?.trim() ?? "";
		let parsed = parseAddressFromText(streetPart);
		let extractedAddress: string | null = null;

		if (!parsed && !plausibleAddress(streetPart)) {
			// No usable address: mine the title for "Street 12" patterns.
			const titlePart = parseAddressFromText(row.title);
			if (titlePart && plausibleAddress(row.title)) {
				parsed = titlePart;
				streetPart = titlePart.number
					? `${titlePart.street} ${titlePart.number}`
					: titlePart.street;
				extractedAddress = [streetPart, row.district, "Kraków"]
					.filter(Boolean)
					.join(", ");
			}
		}

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
					.set({
						lat: local.lat,
						lng: local.lng,
						buildingId,
						...(extractedAddress ? { address: extractedAddress } : {}),
					})
					.where(eq(listings.id, row.id));
				report.localHits++;
				if (extractedAddress) report.titleExtracted++;
				continue;
			}
		}

		// 2. Nominatim street-level fallback (bounded for scheduled runs).
		if (!streetPart || !plausibleAddress(streetPart)) {
			report.misses++;
			continue;
		}
		const query = [streetPart, row.district, "Kraków"]
			.filter(Boolean)
			.join(", ");
		let geo = nomCache.get(query);
		if (geo === undefined) {
			if (nomBudget <= 0) {
				report.misses++;
				continue;
			}
			nomBudget--;
			geo = await nominatimGeocode(query, streetPart);
			nomCache.set(query, geo);
			// Nominatim requires ~1 req/s.
			await new Promise((r) => setTimeout(r, 1050));
		}
		if (geo) {
			await db
				.update(listings)
				.set({
					lat: geo.lat,
					lng: geo.lng,
					...(extractedAddress ? { address: extractedAddress } : {}),
				})
				.where(eq(listings.id, row.id));
			report.nomHits++;
			if (extractedAddress) report.titleExtracted++;
		} else {
			report.misses++;
		}

		if ((i + 1) % 100 === 0) {
			console.log(
				`  ${i + 1}/${rows.length}: local=${report.localHits} ` +
					`nominatim=${report.nomHits} misses=${report.misses}`,
			);
		}
	}

	return report;
}
