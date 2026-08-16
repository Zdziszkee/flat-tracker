import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { buildings, listings } from "#/db/schema";
import {
	buildCityCentroids,
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
 * 3. Street found but not in the local index -> Photon geocoder (1 req/s,
 *    validated to Małopolska, per-address result cache).
 *
 * `nominatimLimit` bounds external calls for the hourly refresh; the CLI
 * (`npm run geocode-addresses`) passes no limit to drain the backlog.
 */

const PHOTON = "https://photon.komoot.io/api/";

/** Małopolska voivodeship bounding box. */
const MALOPOLSKA_BOUNDS = {
	minLng: 19.0,
	minLat: 49.1,
	maxLng: 21.6,
	maxLat: 50.6,
};

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

/**
 * Photon (komoot) forward geocoder — free, keyless, OSM-based, and far less
 * rate-limited than Nominatim. Returns a point only when it shares a word
 * with the query and lies inside Małopolska.
 */
async function photonGeocode(
	address: string,
	streetPart: string,
): Promise<{ lat: number; lng: number } | null> {
	const url = `${PHOTON}?q=${encodeURIComponent(address)}&limit=1`;
	try {
		const res = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const j = (await res.json()) as {
			features?: Array<{
				geometry?: { coordinates?: number[] };
				properties?: Record<string, string>;
			}>;
		};
		const feature = j.features?.[0];
		const coords = feature?.geometry?.coordinates;
		const lat = coords?.[1];
		const lng = coords?.[0];
		if (
			typeof lat !== "number" ||
			typeof lng !== "number" ||
			!Number.isFinite(lat) ||
			!Number.isFinite(lng)
		)
			return null;
		if (
			lat < MALOPOLSKA_BOUNDS.minLat ||
			lat > MALOPOLSKA_BOUNDS.maxLat ||
			lng < MALOPOLSKA_BOUNDS.minLng ||
			lng > MALOPOLSKA_BOUNDS.maxLng
		)
			return null;

		const props = feature?.properties ?? {};
		const shown = normalizeWord(
			[props.name, props.street, props.city].filter(Boolean).join(" "),
		);
		const wanted = normalizeWord(streetPart)
			.split(" ")
			.filter((w) => w.length >= 3);
		if (wanted.length > 0 && !wanted.some((w) => shown.includes(w)))
			return null;
		return { lat, lng };
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
export const NOM_CACHE_PATH = "data/crawler/nominatim-cache.json";

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
		/**
		 * Drop stored coordinates first for these source ids so the whole
		 * address-only feed is re-anchored with the current matcher. Used by
		 * `npm run geocode-addresses -- --reset` to repair stale/wrong pins.
		 */
		resetSources?: string[];
	} = {},
): Promise<GeocodeReport> {
	if (opts.resetSources?.length) {
		await db
			.update(listings)
			.set({ lat: null, lng: null, buildingId: null })
			.where(inArray(listings.source, opts.resetSources));
	}

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
	const cityCentroids = await buildCityCentroids();
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
		// The last non-postal-code segment of the address is usually the city;
		// it disambiguates streets that exist in several towns ("Śląska" in
		// Kraków and Zabierzów).
		const cityHint =
			row.address
				?.split(",")
				.map((s) => s.trim())
				.filter((s) => s && !/^\d{2}-\d{3}$/.test(s))
				.pop() ?? null;

		// Mine free text when the stored address has no usable street: either
		// no address at all, or only a postal code ("33-100, Tarnów"). The
		// title/description of court notices often carries the real street.
		const noUsableStreet =
			!parsed && (!streetPart || /^\d{2}-\d{3}$/.test(streetPart.trim()));
		if (noUsableStreet) {
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
				cityHint,
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
			cityHint,
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

		// City-level offline fallback: only for addresses with no street at all
		// (e.g. "33-100, Tarnów"). An address that names a specific street but
		// failed to match locally must never collapse to the city centroid —
		// that is how whole districts pile up on one wrong point.
		const isZipOnly = /^\d{2}-\d{3}$/.test(streetPart.trim());
		const hasNoStreet = !parsed && (!streetPart || isZipOnly);
		if (hasNoStreet) {
			const cityCentroid = cityCentroids.get(normStreet(cityHint ?? ""));
			if (cityCentroid) {
				await db
					.update(listings)
					.set({ lat: cityCentroid.lat, lng: cityCentroid.lng })
					.where(eq(listings.id, row.id));
				report.localHits++;
				continue;
			}
		}

		// Nominatim street-level fallback (bounded for scheduled runs).
		// Stored structured addresses skip the plausibility gate; only
		// title-mined street parts need it (ad-speak protection).
		if (!streetPart || (!hasStoredAddress && !plausibleAddress(streetPart))) {
			report.misses++;
			continue;
		}
		const namePart = isZipOnly && cityHint ? cityHint : streetPart;
		const streetKey = normStreet(`${streetPart} ${cityHint ?? ""}`);
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
			geo = await photonGeocode(query, namePart);
			if (streetKey) {
				nomCache[streetKey] = geo;
				nomWrites++;
			}
			// Be polite to the free geocoder: ~1 req/s.
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
