/**
 * On-demand EGiB parcel lookup.
 *
 * The region-wide importer (`import-egib.ts`) fills `parcels` tile by tile.
 * A new listing can arrive before its tile is imported, so this module
 * fetches the single parcel that contains a point (or a known registry id)
 * directly from the GUGiK KIEG aggregate WFS and returns it in the same
 * shape the importer stores.
 *
 * WFS limits: the aggregate service caps a page at 1000 features and
 * `STARTINDEX` at 10000. Point and id lookups are one or two features, so
 * those limits never apply here.
 */

import proj4 from "proj4";
import {
	buildEgibWfsQuery,
	cleanEgibValue,
	type EgibParcel,
	fetchEgibWfs,
	parseEgibPage,
	ringAreaM2,
} from "./geo/egib-wfs.ts";

export {
	cleanEgibValue,
	EGiB_WFS_URL,
	type EgibParcel,
	parseEgibPage,
	ringAreaM2,
} from "./geo/egib-wfs.ts";

const UA =
	"flat-tracker/1.0 (cadastral parcel lookup; contact: zdziszkee@gmail.com)";

const ULDK_URL = "https://uldk.gugik.gov.pl/";
/** EPSG:2180, the Polish CS92 projection ULDK returns by default. */
const EPSG2180 =
	"+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +units=m +no_defs";

/**
 * Parse a stored parcel polygon. RCN rows are GeoJSON
 * ({"type":"Polygon","coordinates":[[[lng,lat],...]]}) while EGiB rows are
 * the lighter [{lat,lng},...] array. Return one exterior ring.
 */
export function parseParcelRing(polygon: string): Array<{
	lat: number;
	lng: number;
}> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(polygon);
	} catch {
		return [];
	}
	if (Array.isArray(parsed)) {
		return parsed.filter(
			(p): p is { lat: number; lng: number } =>
				typeof p === "object" &&
				p !== null &&
				typeof (p as { lat?: unknown }).lat === "number" &&
				typeof (p as { lng?: unknown }).lng === "number",
		);
	}
	const geo = parsed as {
		type?: string;
		coordinates?: number[][][] | number[][][][];
	};
	if (geo.type === "Polygon" && Array.isArray(geo.coordinates)) {
		const ring = (geo.coordinates as number[][][])[0] ?? [];
		return ring.map(([lng, lat]) => ({ lat, lng }));
	}
	if (geo.type === "MultiPolygon" && Array.isArray(geo.coordinates)) {
		const ring = (geo.coordinates as number[][][][])[0]?.[0] ?? [];
		return ring.map(([lng, lat]) => ({ lat, lng }));
	}
	return [];
}

/** Even-odd point-in-polygon on a lat/lng ring. */
export function pointInRing(
	ring: Array<{ lat: number; lng: number }>,
	lat: number,
	lng: number,
): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i].lng;
		const yi = ring[i].lat;
		const xj = ring[j].lng;
		const yj = ring[j].lat;
		const intersect =
			yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

/** Fetch the parcel that contains a point. Returns null outside EGiB coverage. */
export async function fetchParcelAtPoint(
	lat: number,
	lng: number,
): Promise<EgibParcel | null> {
	const d = 0.00025; // ~25 m, enough for one urban parcel
	const bbox = `${lat - d},${lng - d},${lat + d},${lng + d},urn:ogc:def:crs:EPSG::4326`;
	const query = buildEgibWfsQuery({ count: 10, bbox });
	const parcels = parseEgibPage(await fetchEgibWfs(query));
	return (
		parcels.find((p) => pointInRing(p.ring, lat, lng)) ?? parcels[0] ?? null
	);
}

/** Fetch one parcel by its registry id (e.g. 126105_9.0145.41/2). */
export async function fetchParcelById(
	parcelId: string,
): Promise<EgibParcel | null> {
	const filter =
		`<Filter><PropertyIsEqualTo><PropertyName>ID_DZIALKI</PropertyName>` +
		`<Literal>${parcelId}</Literal></PropertyIsEqualTo></Filter>`;
	const query = buildEgibWfsQuery({ count: 1, filter });
	const parcels = parseEgibPage(await fetchEgibWfs(query));
	return parcels[0] ?? null;
}

/**
 * Fetch many parcels in one OGC `Or` filter. Callers should keep batches
 * around 50: the filter is URL-encoded and a 100-id request approaches
 * common gateway URL limits.
 */
export async function fetchParcelsByIds(
	parcelIds: string[],
): Promise<EgibParcel[]> {
	if (parcelIds.length === 0) return [];
	const or = parcelIds
		.map(
			(id) =>
				`<PropertyIsEqualTo><PropertyName>ID_DZIALKI</PropertyName>` +
				`<Literal>${id}</Literal></PropertyIsEqualTo>`,
		)
		.join("");
	const filter = `<Filter><Or>${or}</Or></Filter>`;
	const query = buildEgibWfsQuery({ count: parcelIds.length, filter });
	return parseEgibPage(await fetchEgibWfs(query));
}

/** Parse the first ring of a ULDK WKT POLYGON/MULTIPOLYGON. */
function parseWktRing(wkt: string): Array<[number, number]> {
	const body =
		wkt.match(/MULTIPOLYGON\s*\(\(\((.*?)\)\)\)/s)?.[1] ??
		wkt.match(/POLYGON\s*\(\((.*?)\)\)/s)?.[1] ??
		"";
	if (!body) return [];
	const ring: Array<[number, number]> = [];
	for (const pair of body.split(",")) {
		const [x, y] = pair.trim().split(/\s+/).map(Number);
		if (Number.isFinite(x) && Number.isFinite(y)) ring.push([x, y]);
	}
	return ring;
}

interface UldkParcel {
	parcelId: string;
	ring: Array<{ lat: number; lng: number }>;
	obreb: string | null;
	gmina: string | null;
}

/**
 * Parse a ULDK response. `projected` is true for the default EPSG:2180
 * geometry and false when the request asked for srid=4326.
 */
function parseUldkText(text: string, projected: boolean): UldkParcel | null {
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	if (lines[0]?.trim() !== "0" || !lines[1]?.startsWith("SRID=")) return null;
	const wkt = lines[1].slice(lines[1].indexOf(";") + 1);
	const raw = parseWktRing(wkt);
	if (raw.length < 3) return null;
	const ring = projected
		? raw.map(([x, y]) => {
				const [lng, lat] = proj4(EPSG2180, "EPSG:4326", [x, y]);
				return { lat, lng };
			})
		: raw.map(([lng, lat]) => ({ lat, lng }));
	// ULDK appends the attribute suffix to the geometry line:
	//   ...POLYGON((...))|id|voivodeship|county|commune|region
	const attrs = (lines[1].split("))").pop() ?? "")
		.split("|")
		.filter((s) => s.length > 0);
	return {
		parcelId: attrs[0] ?? "",
		ring,
		obreb: cleanEgibValue(attrs[4] ?? null),
		gmina: cleanEgibValue(attrs[3] ?? null),
	};
}

async function getUldk(query: string): Promise<string> {
	const res = await fetch(`${ULDK_URL}?${query}`, {
		headers: { "User-Agent": UA },
		signal: AbortSignal.timeout(25_000),
	});
	if (!res.ok) throw new Error(`ULDK HTTP ${res.status}`);
	return res.text();
}

/**
 * ULDK fallback for powiats missing from the aggregate EGiB WFS (notably
 * śląskie). ULDK queries the powiat service directly, one parcel per call.
 * Respect the public limits: about 200 requests/minute and 10k/day.
 */
export async function fetchParcelByUldk(
	parcelId: string,
): Promise<EgibParcel | null> {
	const query =
		`request=GetParcelById&id=${encodeURIComponent(parcelId)}` +
		"&result=geom_wkt,id,voivodeship,county,commune,region";
	const parsed = parseUldkText(await getUldk(query), true);
	if (!parsed) return null;
	return {
		parcelId: parsed.parcelId || parcelId,
		ring: parsed.ring,
		obreb: parsed.obreb,
		gmina: parsed.gmina,
		landUseClass: null,
		registerGroup: null,
		egibDataDate: null,
		areaHa: ringAreaM2(parsed.ring) / 10_000,
	};
}

/**
 * The current parcel at a point, in WGS84. Use this when an RCN parcel id is
 * stale: the old parcel may have been merged or split, but the transaction
 * coordinate still identifies the current cadastral unit.
 */
export async function fetchParcelAtPointUldk(
	lat: number,
	lng: number,
): Promise<EgibParcel | null> {
	const query =
		`request=GetParcelByXY&xy=${lng},${lat},4326&srid=4326` +
		"&result=geom_wkt,id,voivodeship,county,commune,region";
	const parsed = parseUldkText(await getUldk(query), false);
	if (!parsed) return null;
	return {
		parcelId: parsed.parcelId,
		ring: parsed.ring,
		obreb: parsed.obreb,
		gmina: parsed.gmina,
		landUseClass: null,
		registerGroup: null,
		egibDataDate: null,
		areaHa: ringAreaM2(parsed.ring) / 10_000,
	};
}
