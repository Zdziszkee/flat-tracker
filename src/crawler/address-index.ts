import { isNotNull } from "drizzle-orm";

import { db } from "#/db/index";
import { osmBuildings } from "#/db/schema";

/**
 * Address-based building matching against the local osm_buildings index.
 * RCN transactions carry street + housenumber from notarial records; OSM
 * buildings carry addr:street + addr:housenumber. An exact address match
 * is far more precise than a geo fallback, so it is tried first.
 *
 * The index covers all of małopolska, so the same street name exists in
 * many towns ("Długa" in Kraków, Nowy Targ, Tarnów...). Callers must
 * disambiguate: either a cityHint (filterByCity below) or a georeferenced
 * `near` point with a max distance (cross-town matches are kilometres
 * away; same-town RCN points sit within ~300 m of their building).
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

function stripStreetPrefix(s: string): string {
	return s.replace(STREET_PREFIX_RE, "").trim();
}

/** Split "ul. Jakuba Bojki 12" into {street, number}. */
function parseAddress(address: string): {
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

/** Great-circle distance in meters. */
function haversineM(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const R = 6371000;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Exact street + housenumber match. Returns the building, or null.
 *
 * `near` (georeferenced records): among same street+number buildings,
 * keep only those within `maxDistanceM` (default 300 m) of the point and
 * return the closest. Without it, a region-wide index could anchor a
 * Kraków transaction to the same-numbered house in a different town.
 */
export function matchByAddress(
	index: StreetIndex,
	street: string | null,
	number: string | null,
	cityHint?: string | null,
	near?: { lat: number; lng: number; maxDistanceM?: number },
): StreetBuilding | null {
	if (!street) return null;
	const buildings = filterByCity(buildingsFor(index, street), cityHint);
	if (!buildings || buildings.length === 0) return null;
	if (number) {
		const exact = buildings.filter((b) => b.number === number);
		if (exact.length > 0) {
			if (!near) return exact[0];
			const maxD = near.maxDistanceM ?? 300;
			let best: StreetBuilding | null = null;
			let bestDist = Number.POSITIVE_INFINITY;
			for (const b of exact) {
				const d = haversineM(near.lat, near.lng, b.lat, b.lng);
				if (d < bestDist) {
					bestDist = d;
					best = b;
				}
			}
			return bestDist <= maxD ? best : null;
		}
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
	// Region-wide guard: without a city hint, a street that exists in
	// several towns must not average into one bogus midpoint between
	// them — return null so the caller falls back to Nominatim.
	if (!cityHint) {
		const cities = new Set(
			buildings.filter((b) => b.city).map((b) => normStreet(b.city as string)),
		);
		if (cities.size > 1) return null;
	}
	// Twin-town guard: a city hint cannot disambiguate same-name villages
	// (both "Dąbrowica" tag addr:city=Dąbrowica), so a street set spanning
	// several geographic clusters would average into the empty middle ("73,
	// 33-230, Dąbrowica" landed 30 km from every real house). Drop it so
	// the caller falls through to the geocoder, whose postcode picks the
	// right twin. A single elongated street chains together and survives.
	const core = dominantCluster(buildings);
	if (!core) return null;
	const lat = core.reduce((s, b) => s + b.lat, 0) / core.length;
	const lng = core.reduce((s, b) => s + b.lng, 0) / core.length;
	return { lat, lng, building: null };
}

/**
 * Same-name town disambiguation for the city centroid fallback. Małopolska
 * has several pairs of villages with the same name (two "Leśnica", two
 * "Przybysławice", ...); averaging all their buildings pins listings in the
 * empty middle between the twins. Towns whose buildings form more than one
 * geographic cluster are therefore dropped from the centroid map so the
 * caller falls through to the geocoder (which the postal code can steer to
 * the right twin).
 */
const TOWN_CELL = 0.02; // ~2 km grid
const TOWN_DOMINANT_SHARE = 0.8; // one cluster must hold this share of buildings

/**
 * The points of the town's main flood-fill cluster, or null when the town is
 * ambiguous (several significant clusters, none dominant — twins must fall
 * through to the geocoder, whose postal code can pick the right one).
 * Centroids must be averaged over THIS, not over all points: a handful of
 * mislabeled buildings a county away drags a plain mean kilometres out of
 * the village (a "Krzeczow" pin landed 8 km from every real building).
 */
function dominantCluster(
	points: Array<{ lat: number; lng: number }>,
): Array<{ lat: number; lng: number }> | null {
	if (points.length <= 1) return points;
	const cellOf = (p: { lat: number; lng: number }) =>
		`${Math.floor(p.lat / TOWN_CELL)}:${Math.floor(p.lng / TOWN_CELL)}`;
	const counts = new Map<string, number>();
	for (const p of points)
		counts.set(cellOf(p), (counts.get(cellOf(p)) ?? 0) + 1);
	// Flood-fill 8-neighbourhoods of occupied cells; an elongated village
	// chains together, twin villages kilometres apart do not.
	const seen = new Set<string>();
	const clusters: Array<{ size: number; cells: Set<string> }> = [];
	for (const start of counts.keys()) {
		if (seen.has(start)) continue;
		const cells = new Set<string>();
		const stack = [start];
		seen.add(start);
		while (stack.length > 0) {
			const key = stack.pop() as string;
			cells.add(key);
			const [r, c] = key.split(":").map(Number);
			for (let dr = -1; dr <= 1; dr++) {
				for (let dc = -1; dc <= 1; dc++) {
					const nk = `${r + dr}:${c + dc}`;
					if (counts.has(nk) && !seen.has(nk)) {
						seen.add(nk);
						stack.push(nk);
					}
				}
			}
		}
		const size = [...cells].reduce((s, k) => s + (counts.get(k) ?? 0), 0);
		clusters.push({ size, cells });
	}
	if (clusters.length === 1) return points;
	const dominant = clusters.reduce((a, b) => (a.size >= b.size ? a : b));
	// Twins with no clear majority are ambiguous. Even a handful of
	// buildings splits into distinct cells ("73, 33-230, Dąbrowica" was 2+2
	// houses in two villages 60 km apart).
	if (dominant.size / points.length < TOWN_DOMINANT_SHARE) return null;
	// One settlement plus stray mislabels (a handful of buildings tagged
	// into the wrong county): keep the settlement only — a plain mean over
	// all points is exactly what dragged the "Krzeczow" pin 8 km out.
	const core = points.filter((p) => dominant.cells.has(cellOf(p)));
	return core.length > 0 ? core : points;
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

	const points = new Map<string, Array<{ lat: number; lng: number }>>();
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
		const list = points.get(key) ?? [];
		list.push({ lat: r.centroidLat, lng: r.centroidLng });
		points.set(key, list);
	}

	const out = new Map<string, { lat: number; lng: number }>();
	for (const [key, list] of points) {
		const core = dominantCluster(list);
		if (!core) continue;
		out.set(key, {
			lat: core.reduce((s, p) => s + p.lat, 0) / core.length,
			lng: core.reduce((s, p) => s + p.lng, 0) / core.length,
		});
	}
	return out;
}
