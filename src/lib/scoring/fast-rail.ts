/**
 * Distance to the nearest fast-rail access point.
 *
 * Pure geometry over `FAST_RAIL_STATIONS` (a curated, hand-checked list of the
 * 200 km/h+ stations in the tracked regions plus the documented KDP calls from
 * 2035). No network, no DB, no browser: the alert score must stay
 * deterministic and re-runnable offline.
 *
 * The list is short (single digits) and every call site already holds the
 * offer's coordinates, so a linear scan with a cheap latitude/longitude
 * pre-filter is faster than building an index.
 */

import {
	FAST_RAIL_STATIONS,
	type FastRailStation,
} from "#/data/fast-rail-stations";

/** Earth radius used by the local haversine, metres. */
const EARTH_RADIUS_M = 6_371_000;

/** One degree of latitude, metres (constant enough for a pre-filter). */
const METRES_PER_DEGREE = 111_320;

export interface FastRailMatch {
	station: FastRailStation;
	/** Great-circle distance from the offer to the station, metres. */
	distanceM: number;
	/** True when the station carries the planned KDP service (2035+). */
	kdpPlanned: boolean;
}

/** Great-circle distance between two WGS84 points, metres. */
export function distanceM(
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

/**
 * Nearest fast-rail station, or null when the offer has no coordinates.
 *
 * `maxDistanceM` is only a pre-filter: the result keeps the true distance so
 * the caller decides what it means (a gate at 3 km, a score band, a reason
 * label). Nothing here decides policy.
 */
export function nearestFastRail(
	lat: number | null | undefined,
	lng: number | null | undefined,
	maxDistanceM = 25_000,
): FastRailMatch | null {
	if (lat == null || lng == null) return null;
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	const latWindow = maxDistanceM / METRES_PER_DEGREE;
	let best: FastRailMatch | null = null;
	for (const station of FAST_RAIL_STATIONS) {
		if (Math.abs(station.lat - lat) > latWindow) continue;
		const distance = distanceM(lat, lng, station.lat, station.lng);
		if (distance > maxDistanceM) continue;
		if (best == null || distance < best.distanceM) {
			best = {
				station,
				distanceM: distance,
				kdpPlanned: station.services.includes("kdp_2035"),
			};
		}
	}
	return best;
}

/** Compact label for reason lines and alert cards, e.g. "Kraków Główny (1,4 km)". */
export function fastRailLabel(match: FastRailMatch): string {
	const km = (match.distanceM / 1000).toFixed(1).replace(".", ",");
	return `${match.station.name} (${km} km)`;
}
