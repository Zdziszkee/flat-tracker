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

import { SaxesParser } from "saxes";

export const EGiB_WFS_URL =
	"https://mapy.geoportal.gov.pl/wss/service/PZGIK/EGIB/WFS/UslugaZbiorcza";

const UA =
	"flat-tracker/1.0 (cadastral parcel lookup; contact: zdziszkee@gmail.com)";

export interface EgibParcel {
	parcelId: string;
	ring: Array<{ lat: number; lng: number }>;
	obreb: string | null;
	gmina: string | null;
	landUseClass: string | null;
	registerGroup: string | null;
	egibDataDate: string | null;
	areaHa: number | null;
}

/** EGiB sometimes returns a placeholder when a powiat has no attributes. */
export function cleanEgibValue(value: string | null): string | null {
	if (!value) return null;
	const v = value.trim();
	if (!v) return null;
	if (v.toLowerCase().startsWith("brak_uprawnie")) return null;
	return v;
}

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

/** Shoelace area of a lat/lng ring, projected locally to metres. */
export function ringAreaM2(
	ring: Array<{ lat: number; lng: number }>,
): number {
	if (ring.length < 3) return 0;
	let latSum = 0;
	for (const p of ring) latSum += p.lat;
	const lat0 = latSum / ring.length;
	const mPerDegLat = 110_574;
	const mPerDegLng = 111_320 * Math.cos((lat0 * Math.PI) / 180);
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const a = ring[i];
		const b = ring[(i + 1) % ring.length];
		area += a.lng * mPerDegLng * (b.lat * mPerDegLat);
		area -= b.lng * mPerDegLng * (a.lat * mPerDegLat);
	}
	return Math.abs(area) / 2;
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

interface Pending {
	parcelId: string | null;
	obreb: string | null;
	gmina: string | null;
	landUseClass: string | null;
	registerGroup: string | null;
	egibDataDate: string | null;
	posList: string;
}

type Capture =
	| "id"
	| "obreb"
	| "gmina"
	| "landUseClass"
	| "registerGroup"
	| "egibDataDate"
	| null;

/** Parse one WFS GetFeature GML page into parcels. */
export function parseEgibPage(xml: string): EgibParcel[] {
	const parser = new SaxesParser({ xmlns: false });
	const out: EgibParcel[] = [];
	let member: Pending | null = null;
	let capture: Capture = null;
	let inPosList = false;

	parser.on("opentag", (node) => {
		const name = node.name;
		if (name === "ms:dzialki") {
			member = {
				parcelId: null,
				obreb: null,
				gmina: null,
				landUseClass: null,
				registerGroup: null,
				egibDataDate: null,
				posList: "",
			};
		} else if (member) {
			if (name === "gml:posList") inPosList = true;
			else if (name === "ms:ID_DZIALKI") capture = "id";
			else if (name === "ms:NAZWA_OBREBU") capture = "obreb";
			else if (name === "ms:NAZWA_GMINY") capture = "gmina";
			else if (name === "ms:KLASOUZYTKI_EGIB") capture = "landUseClass";
			else if (name === "ms:GRUPA_REJESTROWA") capture = "registerGroup";
			else if (name === "ms:DATA") capture = "egibDataDate";
		}
	});
	parser.on("text", (t) => {
		if (!member) return;
		if (inPosList) member.posList += t;
		else if (capture === "id") member.parcelId = (member.parcelId ?? "") + t;
		else if (capture === "obreb") member.obreb = (member.obreb ?? "") + t;
		else if (capture === "gmina") member.gmina = (member.gmina ?? "") + t;
		else if (capture === "landUseClass")
			member.landUseClass = (member.landUseClass ?? "") + t;
		else if (capture === "registerGroup")
			member.registerGroup = (member.registerGroup ?? "") + t;
		else if (capture === "egibDataDate")
			member.egibDataDate = (member.egibDataDate ?? "") + t;
	});
	parser.on("closetag", (node) => {
		const name = node.name;
		if (name === "gml:posList") inPosList = false;
		else if (
			name === "ms:ID_DZIALKI" ||
			name === "ms:NAZWA_OBREBU" ||
			name === "ms:NAZWA_GMINY" ||
			name === "ms:KLASOUZYTKI_EGIB" ||
			name === "ms:GRUPA_REJESTROWA" ||
			name === "ms:DATA"
		) {
			capture = null;
		} else if (name === "ms:dzialki" && member) {
			const m = member;
			member = null;
			if (!m.parcelId || !m.posList) return;
			const ring = parsePosList(m.posList);
			if (!ring || ring.length < 3) return;
			out.push({
				parcelId: m.parcelId,
				ring,
				obreb: m.obreb || null,
				gmina: m.gmina || null,
				landUseClass: cleanEgibValue(m.landUseClass),
				registerGroup: cleanEgibValue(m.registerGroup),
				egibDataDate: m.egibDataDate || null,
				areaHa: ringAreaM2(ring) / 10_000,
			});
		}
	});
	parser.write(xml).close();
	return out;
}

/** Parse "lat lon lat lon ..." (URN EPSG::4326 axis order) into {lat,lng}. */
function parsePosList(
	text: string,
): Array<{ lat: number; lng: number }> | null {
	const nums = text.trim().split(/\s+/).map(Number);
	if (nums.length < 6 || nums.length % 2 !== 0) return null;
	const ring: Array<{ lat: number; lng: number }> = [];
	for (let i = 0; i < nums.length; i += 2) {
		const lat = nums[i];
		const lng = nums[i + 1];
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		if (lat < 48.5 || lat > 51 || lng < 18.5 || lng > 22) return null;
		const prev = ring[ring.length - 1];
		if (prev && prev.lat === lat && prev.lng === lng) continue;
		ring.push({ lat, lng });
	}
	if (ring.length > 1) {
		const first = ring[0];
		const last = ring[ring.length - 1];
		if (first.lat === last.lat && first.lng === last.lng) ring.pop();
	}
	return ring;
}

async function getFeature(query: string): Promise<string> {
	const res = await fetch(`${EGiB_WFS_URL}?${query}`, {
		headers: { "User-Agent": UA },
		signal: AbortSignal.timeout(45_000),
	});
	if (!res.ok) throw new Error(`EGiB WFS HTTP ${res.status}`);
	return res.text();
}

/** Fetch the parcel that contains a point. Returns null outside EGiB coverage. */
export async function fetchParcelAtPoint(
	lat: number,
	lng: number,
): Promise<EgibParcel | null> {
	const d = 0.00025; // ~25 m, enough for one urban parcel
	const bbox = `${lat - d},${lng - d},${lat + d},${lng + d},urn:ogc:def:crs:EPSG::4326`;
	const query =
		"SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0&TYPENAMES=ms:dzialki" +
		`&SRSNAME=urn:ogc:def:crs:EPSG::4326&BBOX=${encodeURIComponent(bbox)}` +
		"&COUNT=10";
	const parcels = parseEgibPage(await getFeature(query));
	return parcels.find((p) => pointInRing(p.ring, lat, lng)) ?? parcels[0] ?? null;
}

/** Fetch one parcel by its registry id (e.g. 126105_9.0145.41/2). */
export async function fetchParcelById(
	parcelId: string,
): Promise<EgibParcel | null> {
	const filter =
		`<Filter><PropertyIsEqualTo><PropertyName>ID_DZIALKI</PropertyName>` +
		`<Literal>${parcelId}</Literal></PropertyIsEqualTo></Filter>`;
	const query =
		"SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0&TYPENAMES=ms:dzialki" +
		`&SRSNAME=urn:ogc:def:crs:EPSG::4326&COUNT=1&FILTER=${encodeURIComponent(filter)}`;
	const parcels = parseEgibPage(await getFeature(query));
	return parcels[0] ?? null;
}
