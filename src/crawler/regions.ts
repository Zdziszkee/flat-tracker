/**
 * Region configuration: the single source of truth for every voivodeship the
 * tracker covers. Adapters build their start URLs from `REGIONS` instead of
 * hard-coding a voivodeship slug, so adding a region is one entry here plus
 * whatever portal-specific slug differs (see the fields below).
 *
 * Covered today:
 * - `malopolskie` (Małopolska, TERYT 12) — the original scope.
 * - `slaskie` (Śląsk, TERYT 24) — Katowice and the rest of the voivodeship.
 *
 * `name` is the slug the portals' own search paths use for the voivodeship
 * (`/pl/wyniki/sprzedaz/mieszkanie/malopolskie`, `/nieruchomosci/slaskie/`),
 * NOT its Polish display name. `province` carries that display name (with
 * diacritics), which is what API filters such as licytacje-komornik's
 * `termFilters` expect. `label` is the short human name used in UI strings
 * and source descriptors.
 */

export interface RegionCity {
	/** City slug used by investmap.pl `/api/investment/search?citySlug=`. */
	slug: string;
	/** Display name, also used as an address fallback. */
	name: string;
}

export interface RegionBoundingBox {
	minLat: number;
	maxLat: number;
	minLng: number;
	maxLng: number;
}

export interface Region {
	/** Stable internal id; also the cache-file key for per-region state. */
	id: string;
	/** Voivodeship slug as the portals' search paths spell it. */
	name: string;
	/** Short label for UI strings ("Małopolska", "Śląsk"). */
	label: string;
	/** Full Polish voivodeship name as API filters expect it ("śląskie"). */
	province: string;
	/** TERYT(2) voivodeship code ("12", "24"). */
	teryt: string;
	/** Search bounding box: every in-region point is inside it. */
	bbox: RegionBoundingBox;
	/** Map center as [lng, lat]. */
	center: [number, number];
	/** City shards for portals that search per city (investmap today). */
	cities: RegionCity[];
	/** Booking.com region destination (`dest_id` with `dest_type=region`). */
	bookingDestId: string;
}

export const REGIONS: Region[] = [
	{
		id: "malopolskie",
		name: "malopolskie",
		label: "Małopolska",
		province: "małopolskie",
		teryt: "12",
		bbox: { minLat: 49.15, maxLat: 50.55, minLng: 19.05, maxLng: 21.45 },
		center: [19.94, 50.06],
		cities: [{ slug: "krakow", name: "Kraków" }],
		bookingDestId: "1307",
	},
	{
		id: "slaskie",
		name: "slaskie",
		label: "Śląsk",
		province: "śląskie",
		teryt: "24",
		bbox: { minLat: 49.35, maxLat: 51.02, minLng: 18.3, maxLng: 20.05 },
		center: [19.02, 50.26],
		cities: [{ slug: "katowice", name: "Katowice" }],
		bookingDestId: "1562",
	},
];

/** The region a portal URL slug belongs to, if any. */
export function regionBySlug(slug: string): Region | undefined {
	return REGIONS.find((r) => r.name === slug || r.id === slug);
}

/** A region by id. Throws when the id is unknown: a caller's typo is a bug. */
export function regionById(id: string): Region {
	const region = REGIONS.find((r) => r.id === id);
	if (!region) throw new Error(`unknown region id: ${id}`);
	return region;
}

/** The bounding box in which a point falls, if any (boxes may overlap). */
export function regionsForPoint(lat: number, lng: number): Region[] {
	return REGIONS.filter(
		(r) =>
			lat >= r.bbox.minLat &&
			lat <= r.bbox.maxLat &&
			lng >= r.bbox.minLng &&
			lng <= r.bbox.maxLng,
	);
}

/**
 * The region a coordinate most plausibly belongs to: bbox candidates first
 * (the boxes overlap near the Małopolska/Śląsk border), nearest center wins.
 */
export function regionForPoint(lat: number, lng: number): Region | undefined {
	const candidates = regionsForPoint(lat, lng);
	if (candidates.length > 0) {
		return candidates.sort(
			(a, b) => distanceSq(a, lat, lng) - distanceSq(b, lat, lng),
		)[0];
	}
	// Outside every box (a border town, portal rounding): nearest center.
	return [...REGIONS].sort(
		(a, b) => distanceSq(a, lat, lng) - distanceSq(b, lat, lng),
	)[0];
}

function distanceSq(region: Region, lat: number, lng: number): number {
	const dLat = region.center[1] - lat;
	const dLng = region.center[0] - lng;
	return dLat * dLat + dLng * dLng;
}
