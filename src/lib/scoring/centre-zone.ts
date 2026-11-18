/**
 * The "centre zone" distance for flats.
 *
 * A flat is targeted when it sits in the walkable core of a tracked city, not
 * because a portal happened to label its district: only about a third of the
 * Kraków rows carry a district name, Kazimierz is not a separate district in
 * the data at all, and a "Podgórze" label spans 15 km of the city. Anchors are
 * therefore explicit points (market squares, the axis of each target
 * neighbourhood) and the distance is the minimum over them.
 *
 * The zone is bigger than the strict old town on purpose: Stare Miasto,
 * Kazimierz, Podgórze, Krowodrza, Grzegórzki, Dębniki, Zwierzyniec and Wola
 * Justowska are all in scope, which is why the radius in
 * `CENTRE_ZONE.radiusM` is 4 km rather than a 1 km ring around the Rynek.
 *
 * Coordinates are neighbourhood centres, hand-checked against the local OSM
 * address index (`osm_buildings`) so an anchor sits on a real street rather
 * than in a field. A wrong anchor can only shift a score band; it never states
 * a fact about an offer.
 */

export type CentreAnchorKind = "square" | "district";

export interface CentreAnchor {
	id: string;
	/** Display name, used in reason lines ("Rynek Główny"). */
	name: string;
	city: string;
	region: "malopolskie" | "slaskie";
	kind: CentreAnchorKind;
	lat: number;
	lng: number;
	note: string;
}

export const CENTRE_ANCHORS: readonly CentreAnchor[] = [
	{
		id: "krakow-rynek",
		name: "Rynek Główny",
		city: "Kraków",
		region: "malopolskie",
		kind: "square",
		lat: 50.06163,
		lng: 19.93728,
		note: "Stare Miasto core.",
	},
	{
		id: "krakow-kazimierz",
		name: "Kazimierz (Plac Nowy)",
		city: "Kraków",
		region: "malopolskie",
		kind: "district",
		lat: 50.05151,
		lng: 19.94475,
		note: "Kazimierz, west of the Wisła.",
	},
	{
		id: "krakow-podgorze",
		name: "Podgórze (Plac Bohaterów Getta)",
		city: "Kraków",
		region: "malopolskie",
		kind: "district",
		lat: 50.04611,
		lng: 19.9474,
		note: "Podgórze proper, not Podgórze Duchackie.",
	},
	{
		id: "krakow-krowodrza",
		name: "Krowodrza (Plac Inwalidów)",
		city: "Kraków",
		region: "malopolskie",
		kind: "district",
		lat: 50.06585,
		lng: 19.925,
		note: "Krowodrza around the Plac Inwalidów axis.",
	},
	{
		id: "krakow-grzegorzki",
		name: "Grzegórzki (Rondo Mogilskie)",
		city: "Kraków",
		region: "malopolskie",
		kind: "district",
		lat: 50.0673,
		lng: 19.9629,
		note: "Grzegórzki towards the rail line and Wesoła.",
	},
	{
		id: "krakow-debniki",
		name: "Dębniki (Rondo Matecznego)",
		city: "Kraków",
		region: "malopolskie",
		kind: "district",
		lat: 50.03877,
		lng: 19.9256,
		note: "Dębniki between the Wisła and Zakrzówek.",
	},
	{
		id: "krakow-zwierzyniec",
		name: "Zwierzyniec (Błonia)",
		city: "Kraków",
		region: "malopolskie",
		kind: "district",
		lat: 50.0549,
		lng: 19.9067,
		note: "Zwierzyniec along the Błonia edge.",
	},
	{
		id: "krakow-wola-justowska",
		name: "Wola Justowska",
		city: "Kraków",
		region: "malopolskie",
		kind: "district",
		lat: 50.0635,
		lng: 19.8835,
		note: "Królowej Jadwigi spine, verified against OSM addresses 190-209.",
	},
	{
		id: "katowice-rynek",
		name: "Katowice Rynek",
		city: "Katowice",
		region: "slaskie",
		kind: "square",
		lat: 50.25934,
		lng: 19.02159,
		note: "Śródmieście core.",
	},
];

/** Earth radius used by the local haversine, metres. */
const EARTH_RADIUS_M = 6_371_000;

function haversine(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number,
): number {
	const phi1 = (lat1 * Math.PI) / 180;
	const phi2 = (lat2 * Math.PI) / 180;
	const dPhi = phi2 - phi1;
	const dLambda = ((lng2 - lng1) * Math.PI) / 180;
	const a =
		Math.sin(dPhi / 2) ** 2 +
		Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface CentreMatch {
	anchor: CentreAnchor;
	distanceM: number;
}

/**
 * Nearest centre anchor. Anchors of other cities are skipped when the listing
 * names a city, so a Katowice flat is never measured against the Kraków Rynek
 * (the two are 70 km apart, but the skip keeps the reason label honest).
 */
export function nearestCentreAnchor(
	lat: number | null | undefined,
	lng: number | null | undefined,
	city?: string | null,
): CentreMatch | null {
	if (lat == null || lng == null) return null;
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	const wantCity = city
		?.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
	const candidates =
		wantCity == null || wantCity.length === 0
			? CENTRE_ANCHORS
			: CENTRE_ANCHORS.filter((anchor) =>
					anchor.city
						.toLowerCase()
						.normalize("NFD")
						.replace(/\p{Diacritic}/gu, "")
						.startsWith(wantCity),
				);
	const pool = candidates.length > 0 ? candidates : CENTRE_ANCHORS;
	let best: CentreMatch | null = null;
	for (const anchor of pool) {
		const distance = haversine(lat, lng, anchor.lat, anchor.lng);
		if (best == null || distance < best.distanceM) {
			best = { anchor, distanceM: distance };
		}
	}
	return best;
}

/** Compact label for reason lines, e.g. "1,2 km to Kazimierz (Plac Nowy)". */
export function centreLabel(match: CentreMatch): string {
	const km = (match.distanceM / 1000).toFixed(1).replace(".", ",");
	return `${km} km to ${match.anchor.name}`;
}
