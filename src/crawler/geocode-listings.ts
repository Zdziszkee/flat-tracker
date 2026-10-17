import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { db } from "#/db/index";
import { isInTrackedRegion, TRACKED_REGIONS } from "#/db/region";
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
	lexiconStreetCandidates,
	minedStreetLooksReal,
	type ParsedAddress,
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
 *    validated to the tracked region (Małopolska + Śląsk), per-address
 *    result cache).
 *
 * `nominatimLimit` bounds external calls for the hourly refresh; the CLI
 * (`bun run geocode-addresses`) passes no limit to drain the backlog.
 */

const PHOTON = "https://photon.komoot.io/api/";

/**
 * Photon gets no voivodeship qualifier any more. The app used to append
 * "Małopolska" to every query, which for a Śląskie address returns nothing
 * ("ul. Mariacka 10, Katowice, Małopolska" -> 0 features) and, worse,
 * silently reinterprets a Śląskie town as a Małopolskie one ("Bytom,
 * małopolskie" -> three clothes shops in Kraków). The postal code is the
 * honest disambiguator and works in both voivodeships ("41-902 Bytom",
 * "Mariacka 10, Katowice, 40-014"), so it takes the suffix slot; without
 * one the query stays unqualified and the tracked-region bounds check plus
 * the locality hint (below) reject wrong answers.
 */
/**
 * Tracked voivodeships as Photon spells them in `state` ("województwo
 * śląskie" -> "slask"), derived from `TRACKED_REGIONS` so a new region needs
 * no parallel list here.
 */
const REGION_STEMS = Object.keys(TRACKED_REGIONS).map((region) =>
	region.replace(/ie$/, ""),
);

/**
 * The tracked region a hint names, or null when it names a place. Portals
 * do write "Małopolskie" where a city belongs, and that is a region hint:
 * it can only be validated against Photon's `state`, never against `city`.
 */
function hintedRegionStem(hintKey: string): string | null {
	return REGION_STEMS.find((stem) => hintKey.startsWith(stem)) ?? null;
}

/** A geocoder answer is only useful inside a region we track. */
function inRegionBounds(lat: number, lng: number): boolean {
	return isInTrackedRegion(lat, lng);
}

/**
 * Inflected city names that portals put in titles but not in the structured
 * address ("w Zakopanem"). When the title names one of these and the stored
 * city is a generic fallback, the title city wins — it is usually the real
 * location of the offer.
 */
const TITLE_CITY_FORMS: Record<string, string> = {
	zakopanem: "Zakopane",
	krakowie: "Kraków",
	wieliczce: "Wieliczka",
	tarnowie: "Tarnów",
	olkuszu: "Olkusz",
	chrzanowie: "Chrzanów",
	oświęcimiu: "Oświęcim",
	bochni: "Bochnia",
	"nowym sączu": "Nowy Sącz",
	"nowym targu": "Nowy Targ",
};

/** Demo adapters whose fixtures must never be geocoded. */
const DEMO_SOURCES = new Set(["books", "quotes"]);

/**
 * Court-notice boilerplate (licytacje komornicze): "… przy ul. Szkolnej dla
 * której SR dla Krakowa-Krowodrzy w Krakowie … prowadzi KW nr …". The
 * property description comes first; everything after these markers is
 * about the court, its seat and the land register — never about where the
 * property sits. Cut the title before mining it for a street or city, or
 * the court's seat city hijacks the geocode ("w Krakowie" pinned a
 * Nawojowa Góra plot on the Kraków centroid).
 */
const COURT_MARK_RE =
	/\b(?:dla któr\w*|sąd\w*|sr\b|wydział\w*|ksi[ąa]g wieczyst\w*|kw nr|nr kw|z siedzib\w*|komornik\w*)/iu;

/** The property-describing front of a title (court boilerplate removed). */
export function propertyPartOf(title: string | null | undefined): string {
	if (!title) return "";
	const m = COURT_MARK_RE.exec(title);
	return (m ? title.slice(0, m.index) : title).replace(/\s+/g, " ").trim();
}

function normalizeWord(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** First postal-code segment of a stored address ("32-065, Nawojowa Góra"). */
function zipOf(address: string | null | undefined): string | null {
	return (
		address
			?.split(",")
			.map((s) => s.trim())
			.find((s) => /^\d{2}-\d{3}$/.test(s)) ?? null
	);
}

/**
 * Photon (komoot) forward geocoder — free, keyless, OSM-based, and far less
 * rate-limited than Nominatim. Returns a point only when it shares a word
 * with the street we asked for and lies inside a tracked region.
 *
 * With three candidates (not one) a result that also answers the locality
 * hint beats a lone street-name match: the same street exists in both
 * voivodeships ("Mariacka" in Kraków and Katowice, "Zwycięstwa" in Gliwice
 * and Knurów), and the voivodeship suffix that used to filter those out is
 * gone. A street-name match that cannot confirm the hint is still accepted
 * as a fallback, so this only ever turns a miss into a pin, never the other
 * way round.
 */
async function photonGeocode(
	address: string,
	streetPart: string,
	hint?: string | null,
): Promise<{ lat: number; lng: number } | null> {
	const url = `${PHOTON}?q=${encodeURIComponent(address)}&limit=3`;
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
		// No meaningful word to check ("73", a bare house number): accepting
		// any in-bounds result is how listings end up on random points.
		const wanted = normalizeWord(streetPart)
			.split(" ")
			.filter((w) => w.length >= 3);
		if (wanted.length === 0) return null;

		const hintKey = normalizeWord(hint ?? "");
		const stem = hintKey ? hintedRegionStem(hintKey) : null;
		let fallback: { lat: number; lng: number } | null = null;

		for (const feature of j.features ?? []) {
			const coords = feature.geometry?.coordinates;
			const lat = coords?.[1];
			const lng = coords?.[0];
			if (
				typeof lat !== "number" ||
				typeof lng !== "number" ||
				!Number.isFinite(lat) ||
				!Number.isFinite(lng)
			)
				continue;
			if (!inRegionBounds(lat, lng)) continue;

			const props = feature.properties ?? {};
			const shown = normalizeWord(
				[
					props.name,
					props.street,
					props.city,
					props.district,
					props.state,
					props.postcode,
				]
					.filter(Boolean)
					.join(" "),
			);
			if (!wanted.some((w) => shown.includes(w))) continue;

			const point = { lat, lng };
			if (!hintKey) return point;
			const answersHint = stem
				? normalizeWord(props.state ?? "").includes(stem)
				: shown.includes(hintKey);
			if (answersHint) return point;
			fallback ??= point;
		}
		return fallback;
	} catch {
		return null;
	}
}

/** OSM place values that identify a locality (as opposed to a house/POI). */
const PLACE_VALUES = new Set([
	"village",
	"town",
	"city",
	"hamlet",
	"suburb",
	"neighbourhood",
	"locality",
	"isolated_dwelling",
]);

/**
 * Locality-only Photon geocode: resolve a bare village/town name with no
 * street (komornik plots/houses, e.g. "Pstroszyce II") to its place centroid.
 * The offline city index only knows cities tagged on OSM buildings, so small
 * villages must fall back to Photon's place nodes. Restricts to place-typed
 * features (a church/house with a similar name must not win) and requires the
 * result to contain every significant query word. `qualifier` is the postal
 * code (disambiguates same-name towns: "Leśnica" in gm. Stryszów vs. near
 * Krościenko) or a voivodeship name, and `null` means "ask for the bare name".
 */
async function geocodeLocality(
	name: string,
	qualifier?: string | null,
): Promise<{ lat: number; lng: number } | null> {
	const query = [qualifier, name].filter(Boolean).join(" ");
	const url = `${PHOTON}?q=${encodeURIComponent(query)}&limit=5`;
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
		const wanted = normalizeWord(name)
			.split(" ")
			.filter((w) => w.length >= 4);
		for (const feature of j.features ?? []) {
			const props = feature.properties ?? {};
			const isPlace =
				props.osm_key === "place" ||
				(props.osm_value != null && PLACE_VALUES.has(props.osm_value));
			if (!isPlace) continue;
			const coords = feature.geometry?.coordinates;
			const lat = coords?.[1];
			const lng = coords?.[0];
			if (
				typeof lat !== "number" ||
				typeof lng !== "number" ||
				!Number.isFinite(lat) ||
				!Number.isFinite(lng)
			)
				continue;
			if (!inRegionBounds(lat, lng)) continue;
			const shown = normalizeWord(
				[props.name, props.city].filter(Boolean).join(" "),
			);
			if (wanted.length > 0 && !wanted.every((w) => shown.includes(w)))
				continue;
			return { lat, lng };
		}
		return null;
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
		 * `bun run geocode-addresses -- --reset` to repair stale/wrong pins.
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

	rowLoop: for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		const hasStoredAddress = Boolean(row.address?.trim());
		// The street part is always the first comma segment of a stored
		// address; fall back to parsing it out of the title.
		let streetPart = row.address?.split(",")[0]?.trim() ?? "";
		let parsed = parseAddressFromText(streetPart);
		let extractedAddress: string | null = null;
		// The last non-postal-code segment of the address is usually the city;
		// it disambiguates streets that exist in several towns ("Śląska" in
		// Kraków and Zabierzów). When the address carries no city, fall back to
		// the portal's district/locality (morizon/gratka feed only "Krowodrza",
		// komornik only "Pstroszyce II"), so locality-only listings still land.
		const addressCity =
			row.address
				?.split(",")
				.map((s) => s.trim())
				.filter((s) => s && !/^\d{2}-\d{3}$/.test(s))
				.pop() ?? null;
		let cityHint =
			addressCity ?? (row.district?.trim() ? row.district.trim() : null);

		// A portal title often names the real town while the structured
		// address carries a generic "Kraków" fallback ("w Zakopanem przy ul.
		// Paryskich, Kraków"). Trust the title city in that case — but only
		// then: a specific town the offline city index knows ("Tenczynek",
		// "Nawojowa Góra") is always more trustworthy than a title mention,
		// which in court notices is the court's seat, not the property
		// ("Sąd Rejonowy dla Krakowa-Krowodrzy w Krakowie").
		const titleScope = propertyPartOf(row.title);
		const titleLower = titleScope.toLowerCase();
		const hintKey = normStreet(cityHint ?? "");
		const hintIsSpecificTown =
			hintKey !== "krakow" && cityCentroids.has(hintKey);
		if (!hintIsSpecificTown) {
			for (const [form, city] of Object.entries(TITLE_CITY_FORMS)) {
				if (titleLower.includes(form)) {
					if (!cityHint || normStreet(cityHint) !== normStreet(city)) {
						cityHint = city;
					}
					break;
				}
			}
		}

		// Mine free text for "Street 12" patterns and conservative lexicon
		// hints when the stored address has no usable street (none at all, a
		// postal code "33-100, Tarnów", or a stored street the parser now
		// rejects as boilerplate "położone na 1", "o pow. 1,1600ha" — `parsed`
		// is null in all three cases). The candidates also run later when the
		// stored street parsed but resolved nowhere locally (junk like
		// "Maja chyba postawić 2" or "Padniewskiwgo" that would otherwise
		// block title re-mining, because stored addresses are otherwise
		// trusted).
		const titlePart = parseAddressFromText(titleScope);
		const descPart = parseAddressFromText(row.description);
		// The plausibleAddress gate only applies to free-text mining — ad
		// speak like "Przytulne 27" would otherwise geocode to a random
		// street. Stored addresses come from structured portal data and are
		// trusted. Descriptions are full of numbers ("45 m²", "rok 2014"), so
		// the digit-based plausibleAddress gate is meaningless for them: only
		// trust a description-mined street when it maps to the Krakow lexicon
		// or carries a housenumber. Lexicon hints need no plausibility gate —
		// an exact lexicon match is a stronger signal than the gate.
		const mined: Array<{ part: ParsedAddress; text: string | null }> = [];
		if (
			titlePart &&
			plausibleAddress(titleScope) &&
			minedStreetLooksReal(titlePart.street)
		) {
			mined.push({ part: titlePart, text: titleScope });
		}
		if (
			descPart &&
			(isKnownKrakowStreet(descPart.street) || descPart.number) &&
			minedStreetLooksReal(descPart.street)
		) {
			mined.push({ part: descPart, text: row.description });
		}
		for (const part of lexiconStreetCandidates(titleScope)) {
			if (minedStreetLooksReal(part.street))
				mined.push({ part, text: titleScope });
		}

		// Show the real town when we know one ("Zielone Zarabie,
		// Myślenice"); "Małopolska" is the region fallback placeholder.
		const displayCity =
			cityHint && cityCentroids.has(normStreet(cityHint))
				? cityHint
				: "Małopolska";
		const minedAddress = (part: ParsedAddress): string =>
			[
				part.number ? `${part.street} ${part.number}` : part.street,
				row.district,
				displayCity,
			]
				.filter((s, i, arr): s is string => Boolean(s) && arr.indexOf(s) === i)
				.join(", ");

		// Try a candidate against the local index: exact building first
		// (address claim), then the street centroid (no building claim).
		const tryLocal = async (part: ParsedAddress): Promise<boolean> => {
			const local = matchByAddress(
				streetIndex,
				part.street,
				part.number ?? null,
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
						address: minedAddress(part),
					})
					.where(eq(listings.id, row.id));
				return true;
			}
			const centroid = matchAddressString(
				streetIndex,
				part.number ? `${part.street} ${part.number}` : part.street,
				cityHint,
			);
			if (centroid) {
				await db
					.update(listings)
					.set({
						lat: centroid.lat,
						lng: centroid.lng,
						address: minedAddress(part),
					})
					.where(eq(listings.id, row.id));
				return true;
			}
			return false;
		};

		// The first candidate represents the mining result for the later
		// phases (Nominatim query, persisted address on a remote hit).
		let firstCandidateTried = false;
		if (!parsed && mined.length > 0) {
			parsed = mined[0].part;
			streetPart = parsed.number
				? `${parsed.street} ${parsed.number}`
				: parsed.street;
			extractedAddress = minedAddress(mined[0].part);
			// Falls into the shared local match just below.
			firstCandidateTried = true;
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

		// The stored street (or the first candidate) resolved nowhere
		// locally: try the remaining mined candidates before the remote
		// fallbacks. A candidate that resolves nowhere leaves the stored
		// address untouched.
		for (const cand of mined.slice(firstCandidateTried ? 1 : 0)) {
			if (await tryLocal(cand.part)) {
				report.localHits++;
				report.titleExtracted++;
				continue rowLoop;
			}
		}

		// City-level offline fallback: only for addresses with no street at all
		// (e.g. "33-100, Tarnów"). An address that names a specific street but
		// failed to match locally must never collapse to the city centroid —
		// that is how whole districts pile up on one wrong point.
		const isZipOnly = /^\d{2}-\d{3}$/.test(streetPart.trim());
		// A bare house number ("73, 33-230, Dąbrowica" — street unknown) is
		// not a street name; treat the row as street-less so it lands on the
		// town instead of whatever the geocoder makes of "73".
		const isBareNumber = /^\d{1,4}[A-Za-z]?$/.test(streetPart.trim());
		const hasNoStreet = !parsed && (!streetPart || isZipOnly || isBareNumber);
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
			// Locality-only fallback: a bare village/town name with no street
			// (komornik plots/houses, e.g. "Pstroszyce II"). The offline index
			// only knows cities tagged on OSM buildings, so resolve the name
			// against Photon's place nodes (cached, budgeted, ~1 req/s).
			if (cityHint) {
				const zip = zipOf(row.address);
				const localityKey = normStreet(`loc:${cityHint} ${zip ?? ""}`);
				let locality: { lat: number; lng: number } | null | undefined;
				if (localityKey in nomCache) {
					locality = nomCache[localityKey];
				} else if (nomBudget <= 0) {
					report.misses++;
					continue;
				} else {
					// Three attempts, cheapest signal first: the postal code
					// (unambiguous, and the only qualifier that works in both
					// voivodeships), then the legacy "małopolskie" hint — the
					// same-name village in the other voivodeship is the trap it
					// guards against, so it keeps its precedence — then the bare
					// name, which is how a Śląskie locality that no Małopolska
					// query can find finally resolves ("Sączów").
					const attempts: Array<string | null> = zip
						? [zip, "małopolskie", null]
						: ["małopolskie", null];
					let found: { lat: number; lng: number } | null = null;
					for (const qualifier of attempts) {
						if (found || nomBudget <= 0) break;
						nomBudget--;
						found = await geocodeLocality(cityHint, qualifier);
					}
					locality = found;
					// A known miss is cached as null, so the drain never re-asks.
					nomCache[localityKey] = found;
					nomWrites++;
					await new Promise((r) => setTimeout(r, 1050));
				}
				if (locality) {
					await db
						.update(listings)
						.set({ lat: locality.lat, lng: locality.lng })
						.where(eq(listings.id, row.id));
					report.nomHits++;
					continue;
				}
			}
			report.misses++;
			continue;
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
			const query = extractedAddress
				? // A mined street must not fall back to the stored street-less
					// address ("32-065, Nawojowa Góra") — query what we mined.
					[streetPart, cityHint ?? row.district, zipOf(row.address)]
						.filter(Boolean)
						.join(", ")
				: hasStoredAddress && row.address
					? row.address
					: [streetPart, row.district, zipOf(row.address)]
							.filter(Boolean)
							.join(", ");
			geo = await photonGeocode(query, namePart, cityHint ?? row.district);
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
