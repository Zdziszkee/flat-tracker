/**
 * City-level external price references (finwire.pl, RCN-derived).
 *
 * Kept free of DB and crawler imports so the valuation model can resolve a
 * comparable's city without pulling the importer graph in. The importer
 * (`src/crawler/import-finwire.ts`) reuses the same city list, so a city the
 * resolver names is a city the importer actually wrote rows for.
 */

export interface ExternalCity {
	slug: string;
	name: string;
	region: "malopolskie" | "slaskie";
	lat: number;
	lng: number;
}

/**
 * Only the tracked cities. finwire publishes 17 Polish cities, but an index
 * whose comparables never live there would just be dead rows, so the
 * import/resolve pair stays inside małopolskie + śląskie.
 */
export const EXTERNAL_CITIES: readonly ExternalCity[] = [
	{
		slug: "krakow",
		name: "Kraków",
		region: "malopolskie",
		lat: 50.0647,
		lng: 19.945,
	},
	{
		slug: "katowice",
		name: "Katowice",
		region: "slaskie",
		lat: 50.2649,
		lng: 19.0238,
	},
];

/** Nearest tracked city within 100 km, else the regional proxy, else null. */
export function externalCityFor(
	lat: number | null,
	lng: number | null,
	region: string | null,
): string | null {
	if (lat != null && lng != null) {
		let best: ExternalCity | null = null;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const city of EXTERNAL_CITIES) {
			const distance = haversineM(lat, lng, city.lat, city.lng);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = city;
			}
		}
		// Kraków and Katowice are ~80 km apart, so < 100 km is unambiguous;
		// farther places (Tarnów, Bielsko-Biała) use the voivodeship proxy.
		if (best && bestDistance <= 100_000) return best.slug;
	}
	if (region === "malopolskie") return "krakow";
	if (region === "slaskie") return "katowice";
	return null;
}

function haversineM(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number,
): number {
	const R = 6_371_000;
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLng = toRad(lng2 - lng1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}
