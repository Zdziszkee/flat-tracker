import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { buildings, listings } from "#/db/schema";
import {
	buildStreetIndex,
	matchAddressString,
	matchByAddress,
	normStreet,
} from "./address-index.ts";
import {
	isKnownKrakowStreet,
	parseAddressFromText,
	plausibleAddress,
} from "./sites/address.ts";

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

/** Małopolska voivodeship bounding box. */
const MALOPOLSKA_BOUNDS = {
	minLng: 19.0,
	minLat: 49.1,
	maxLng: 21.6,
	maxLat: 50.6,
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
		lat < MALOPOLSKA_BOUNDS.minLat ||
		lat > MALOPOLSKA_BOUNDS.maxLat ||
		lng < MALOPOLSKA_BOUNDS.minLng ||
		lng > MALOPOLSKA_BOUNDS.maxLng
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

/**
 * Persistent Nominatim result cache (data/crawler/nominatim-cache.json).
 * The drain runs in short-lived processes (chunked loops), so an
 * in-memory cache dies with each chunk and the same streets get
 * re-queried. Keyed by normalized street name; null = known miss.
 */
const NOM_CACHE_PATH = "data/crawler/nominatim-cache.json";

type NomCache = Record<string, { lat: number; lng: number } | null>;

async function loadNomCache(): Promise<NomCache> {
	try {
		return JSON.parse(await readFile(NOM_CACHE_PATH, "utf8")) as NomCache;
	} catch {
		return {};
	}
}

async function saveNomCache(cache: NomCache): Promise<void> {
	await mkdir(dirname(NOM_CACHE_PATH), { recursive: true });
	await writeFile(NOM_CACHE_PATH, JSON.stringify(cache));
}

export async function geocodeUnlocatedListings(
	opts: {
		/** Max Nominatim requests this run (undefined = unlimited). */
		nominatimLimit?: number;
		/** Restrict to these source ids (undefined = all). */
		sources?: string[];
	} = {},
): Promise<GeocodeReport> {
	const rows = db
		.select({
			id: listings.id,
			source: listings.source,
			title: listings.title,
			address: listings.address,
			description: listings.description,
			district: listings.district,
		})
		.from(listings)
		.where(and(isNull(listings.lat), isNotNull(listings.title)))
		.all()
		.filter((row) => !DEMO_SOURCES.has(row.source))
		.filter((row) => !opts.sources || opts.sources.includes(row.source));

	const report: GeocodeReport = {
		total: rows.length,
		localHits: 0,
		nomHits: 0,
		titleExtracted: 0,
		misses: 0,
	};
	if (rows.length === 0) return report;

	const streetIndex = await buildStreetIndex();
	// Persistent Nominatim cache, keyed by normalized street — survives
	// the chunked drain processes and dedupes morizon/gratka duplicates.
	const nomCache = await loadNomCache();
	let nomBudget = opts.nominatimLimit ?? Number.POSITIVE_INFINITY;
	let nomWrites = 0;

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const hasStoredAddress = Boolean(row.address?.trim());
		// The street part is always the first comma segment of a stored
		// address; fall back to parsing it out of the title.
		let streetPart = row.address?.split(",")[0]?.trim() ?? "";
		let parsed = parseAddressFromText(streetPart);
		let extractedAddress: string | null = null;

		// Only mine free text when there is no stored address. A stored
		// street without a housenumber ("Doktora Jana Piltza") must still be
		// geocoded via its street centroid, not overwritten by title-speak.
		if (!hasStoredAddress && !parsed && !plausibleAddress(streetPart)) {
			// No usable address: mine the title, then the description, for
			// "Street 12" patterns. The plausibleAddress gate only applies to
			// free-text mining — ad speak like "Przytulne 27" would otherwise
			// geocode to a random street. Stored addresses come from
			// structured portal data and are trusted.
			const titlePart = parseAddressFromText(row.title);
			const descPart = parseAddressFromText(row.description);
			// Descriptions are full of numbers ("45 m²", "rok 2014"), so the
			// digit-based plausibleAddress gate is meaningless for them. Only
			// trust a description-mined street when it maps to the Krakow
			// lexicon; otherwise the title result (or nothing) wins.
			const mined =
				titlePart && plausibleAddress(row.title)
					? { part: titlePart, text: row.title }
					: descPart && isKnownKrakowStreet(descPart.street)
						? { part: descPart, text: row.description }
						: null;
			if (mined) {
				parsed = mined.part;
				streetPart = mined.part.number
					? `${mined.part.street} ${mined.part.number}`
					: mined.part.street;
				extractedAddress = [streetPart, row.district, "Małopolska"]
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

		// Street-only fallback: exact building unknown, but the local index
		// still has a street centroid — a good map anchor without claiming
		// a specific building's history.
		const centroid = matchAddressString(
			streetIndex,
			parsed
				? `${parsed.street}${parsed.number ? ` ${parsed.number}` : ""}`
				: streetPart,
		);
		if (centroid) {
			await db
				.update(listings)
				.set({
					lat: centroid.lat,
					lng: centroid.lng,
					...(extractedAddress ? { address: extractedAddress } : {}),
				})
				.where(eq(listings.id, row.id));
			report.localHits++;
			if (extractedAddress) report.titleExtracted++;
			continue;
		}

		// Nominatim street-level fallback (bounded for scheduled runs).
		// Stored structured addresses skip the plausibility gate; only
		// title-mined street parts need it (ad-speak protection).
		if (!streetPart || (!hasStoredAddress && !plausibleAddress(streetPart))) {
			report.misses++;
			continue;
		}
		const streetKey = normStreet(streetPart);
		// `in` check: a cached null is a known miss and must not re-query.
		let geo =
			streetKey && streetKey in nomCache ? nomCache[streetKey] : undefined;
		if (geo === undefined) {
			if (nomBudget <= 0) {
				report.misses++;
				continue;
			}
			nomBudget--;
			const query =
				hasStoredAddress && row.address
					? row.address
					: [streetPart, row.district, "Małopolska"].filter(Boolean).join(", ");
			geo = await nominatimGeocode(query, streetPart);
			if (streetKey) {
				nomCache[streetKey] = geo;
				nomWrites++;
			}
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
			if (nomWrites > 0) {
				await saveNomCache(nomCache);
				nomWrites = 0;
			}
		}
	}

	if (nomWrites > 0) await saveNomCache(nomCache);

	return report;
}
