/**
 * Shared GUGiK KIEG aggregate WFS plumbing for the EGiB parcel layer.
 *
 * Both the on-demand lookups (`egib.ts`) and the region-wide importer
 * (`import-egib.ts`) talk to the same service, request the same
 * `ms:dzialki` feature type, and parse the same GML page. Keeping the URL,
 * query builder, fetcher and saxes parser here means a change to the
 * service contract (a renamed attribute, a new required parameter) lands in
 * one place instead of two copies that silently drift.
 *
 * WFS limits: a page holds at most 1000 features and `STARTINDEX` caps at
 * 10000. Bulk tile import must therefore split large boxes; point and id
 * lookups never approach either limit.
 */

import { SaxesParser } from "saxes";

export const EGiB_WFS_URL =
	"https://mapy.geoportal.gov.pl/wss/service/PZGIK/EGIB/WFS/UslugaZbiorcza";

const EGiB_WFS_USER_AGENT =
	"flat-tracker/1.0 (cadastral parcel import; contact: zdziszkee@gmail.com)";

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

/** Shoelace area of a lat/lng ring, projected locally to metres. */
export function ringAreaM2(ring: Array<{ lat: number; lng: number }>): number {
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

export interface EgibWfsQuery {
	/** Max features in the page (server cap: 1000). */
	count: number;
	/** `minLat,minLng,maxLat,maxLng,urn:ogc:def:crs:EPSG::4326`. */
	bbox?: string;
	/** Offset for paged tile reads. */
	startIndex?: number;
	/** Request `SORTBY=ms:ID_DZIALKI`; required for stable pagination. */
	sortBy?: boolean;
	/** An OGC filter, unencoded (the builder URL-encodes it). */
	filter?: string;
}

/** Build one GetFeature query string (without the leading `?`). */
export function buildEgibWfsQuery({
	count,
	bbox,
	startIndex,
	sortBy,
	filter,
}: EgibWfsQuery): string {
	let query =
		"SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0&TYPENAMES=ms:dzialki" +
		"&SRSNAME=urn:ogc:def:crs:EPSG::4326" +
		`&COUNT=${count}`;
	if (bbox) query += `&BBOX=${encodeURIComponent(bbox)}`;
	if (startIndex != null) query += `&STARTINDEX=${startIndex}`;
	if (sortBy) query += "&SORTBY=ms:ID_DZIALKI";
	if (filter) query += `&FILTER=${encodeURIComponent(filter)}`;
	return query;
}

export class EgibWfsError extends Error {
	constructor(readonly status: number) {
		super(`EGiB WFS HTTP ${status}`);
		this.name = "EgibWfsError";
	}
}

/** Fetch one query. Throws `EgibWfsError` on a non-2xx response. */
export async function fetchEgibWfs(
	query: string,
	timeoutMs = 25_000,
): Promise<string> {
	const res = await fetch(`${EGiB_WFS_URL}?${query}`, {
		headers: { "User-Agent": EGiB_WFS_USER_AGENT },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new EgibWfsError(res.status);
	return res.text();
}

interface PendingParcel {
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
	// Full-document mode: the WFS response starts with an XML declaration,
	// which fragment mode rejects.
	const parser = new SaxesParser({ xmlns: false });
	const out: EgibParcel[] = [];
	let member: PendingParcel | null = null;
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
		// tracked-region sanity bounds (wider than either box on purpose)
		if (lat < 48.5 || lat > 51 || lng < 18.5 || lng > 22) return null;
		const prev = ring[ring.length - 1];
		// drop consecutive duplicates
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
