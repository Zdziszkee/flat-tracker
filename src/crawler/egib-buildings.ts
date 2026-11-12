/**
 * EGiB building footprint lookups.
 *
 * The aggregate EGiB WFS exposes `ms:budynki` with `RODZAJ`,
 * `KONDYGNACJE_NADZIEMNE` and polygon geometry. The BBOX axis order for
 * EPSG:4326 is lat,lng on this service, not lng,lat.
 */

import { cleanEgibValue, pointInRing, ringAreaM2 } from "./egib.ts";

const EGiB_WFS =
	"https://mapy.geoportal.gov.pl/wss/service/PZGIK/EGIB/WFS/UslugaZbiorcza";

export interface EgibBuildingRing {
	lat: number;
	lng: number;
}

export interface EgibBuilding {
	id: string;
	kind: string | null;
	floors: number | null;
	ring: EgibBuildingRing[];
	areaM2: number;
}

interface WfsGeometry {
	type?: string;
	coordinates?: number[][][] | number[][][][];
}

interface WfsFeature {
	properties?: Record<string, string | null>;
	geometry?: WfsGeometry;
}

function ringFromGeometry(
	geometry: WfsGeometry | undefined,
): EgibBuildingRing[] {
	if (!geometry?.coordinates) return [];
	let ring: number[][] = [];
	if (geometry.type === "Polygon") {
		ring = (geometry.coordinates as number[][][])[0] ?? [];
	} else if (geometry.type === "MultiPolygon") {
		// Pick the largest polygon part by projected area.
		let best = 0;
		for (const polygon of geometry.coordinates as number[][][][]) {
			const candidate = polygon[0] ?? [];
			if (ringAreaM2(candidate.map(([lng, lat]) => ({ lat, lng }))) > best) {
				best = ringAreaM2(candidate.map(([lng, lat]) => ({ lat, lng })));
				ring = candidate;
			}
		}
	}
	return ring.map(([lng, lat]) => ({ lat, lng }));
}

function parseFloors(value: string | null | undefined): number | null {
	const cleaned = cleanEgibValue(value ?? null);
	if (!cleaned) return null;
	const parsed = Number.parseInt(cleaned, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Fetch building footprints in a WGS84 bbox. The service caps at 1,000 per page. */
export async function fetchEgibBuildingsByBbox(
	minLat: number,
	minLng: number,
	maxLat: number,
	maxLng: number,
	pageSize = 1000,
): Promise<EgibBuilding[]> {
	const out: EgibBuilding[] = [];
	let start = 0;
	while (start < 20_000) {
		const params = new URLSearchParams({
			SERVICE: "WFS",
			REQUEST: "GetFeature",
			VERSION: "2.0.0",
			TYPENAMES: "ms:budynki",
			SRSNAME: "urn:ogc:def:crs:EPSG::4326",
			COUNT: String(pageSize),
			STARTINDEX: String(start),
			OUTPUTFORMAT: "application/json",
			BBOX: `${minLat},${minLng},${maxLat},${maxLng},urn:ogc:def:crs:EPSG::4326`,
		});
		const response = await fetch(`${EGiB_WFS}?${params.toString()}`, {
			headers: { "User-Agent": "flat-tracker/1.0 (parcel enrichment)" },
			signal: AbortSignal.timeout(45_000),
		});
		if (!response.ok) {
			throw new Error(`EGiB buildings HTTP ${response.status}`);
		}
		const json = (await response.json()) as { features?: WfsFeature[] };
		const features = json.features ?? [];
		for (const feature of features) {
			const ring = ringFromGeometry(feature.geometry);
			if (ring.length < 3) continue;
			const props = feature.properties ?? {};
			out.push({
				id: props.ID_BUDYNKU ?? "",
				kind: cleanEgibValue(props.RODZAJ ?? null),
				floors: parseFloors(props.KONDYGNACJE_NADZIEMNE ?? null),
				ring,
				areaM2: ringAreaM2(ring),
			});
		}
		if (features.length < pageSize) break;
		start += pageSize;
	}
	return out;
}

function centroidOf(ring: EgibBuildingRing[]): EgibBuildingRing {
	let lat = 0;
	let lng = 0;
	for (const p of ring) {
		lat += p.lat;
		lng += p.lng;
	}
	return { lat: lat / ring.length, lng: lng / ring.length };
}

function buildingTouchesParcel(
	building: EgibBuildingRing[],
	parcel: EgibBuildingRing[],
): boolean {
	const c = centroidOf(building);
	if (pointInRing(parcel, c.lat, c.lng)) return true;
	for (const p of building) {
		if (pointInRing(parcel, p.lat, p.lng)) return true;
	}
	const pc = centroidOf(parcel);
	return pointInRing(building, pc.lat, pc.lng);
}

export interface EgibBuildingStats {
	count: number;
	areaM2: number | null;
	floorAreaM2: number | null;
	floors: number | null;
	residentialRatio: number | null;
	coverage: number | null;
}

/** Footprint and floor statistics for buildings touching a parcel. */
export function egibBuildingStats(
	parcelRing: EgibBuildingRing[],
	buildings: EgibBuilding[],
	parcelAreaM2: number,
): EgibBuildingStats {
	let count = 0;
	let area = 0;
	let residentialArea = 0;
	let floorArea = 0;
	let footprintWithFloors = 0;

	for (const building of buildings) {
		if (!buildingTouchesParcel(building.ring, parcelRing)) continue;
		count++;
		area += building.areaM2;
		if (building.kind === "m") residentialArea += building.areaM2;
		if (building.floors !== null) {
			floorArea += building.areaM2 * building.floors;
			footprintWithFloors += building.areaM2;
		}
	}

	return {
		count,
		areaM2: count > 0 ? area : null,
		floorAreaM2: footprintWithFloors > 0 ? floorArea : null,
		floors: footprintWithFloors > 0 ? floorArea / footprintWithFloors : null,
		residentialRatio: area > 0 ? residentialArea / area : null,
		coverage: parcelAreaM2 > 0 ? Math.min(1, area / parcelAreaM2) : null,
	};
}
