/**
 * Krakow planning, WZ, flood and building-permit lookups.
 *
 * The city publishes these layers as ArcGIS REST services behind the MSIP
 * map apps. They are public, need no key, and are point-queryable, which is
 * exactly what parcel enrichment needs. Other powiats keep the RCN
 * `parcel_meta.zoning` labels; Krakow is the large gap because its RCN
 * package is intentionally skipped by the GUGiK importer.
 *
 * All queries use EPSG:4326 points and return attributes only.
 */

const MPZP_URL =
	"https://msip3.um.krakow.pl/server/rest/services/Planowanie/BP_MPZP/MapServer";
const PLANNING_URL =
	"https://msip3.um.krakow.pl/server/rest/services/Architektura/AU_Sos/MapServer";
const FLOOD_URL =
	"https://msip3.um.krakow.pl/hosting/rest/services/Mapy_powodziowe/Mapy_ryzyka_powodziowego_hosting/MapServer";

const MPZP_ZONE_LAYERS = [1, 2, 3];
const WZ_LAYERS = [6, 7, 8, 9, 10];
const PERMIT_LAYERS = [0, 1, 2, 3, 4];
const FLOOD_LAYERS = [13, 31, 49, 61, 72, 83, 99, 111, 128, 146, 159, 170];

export interface MpzpZone {
	nazwa: string | null;
	oznaczenie: string | null;
	rodzaj: string | null;
	opis: string | null;
	dataObowiazywania: string | null;
}

export interface WzDecision {
	sygnatura: string | null;
	numer: string | null;
	rodzaj: string | null;
	zakres: string | null;
	dataDecyzji: string | null;
	dataOstatecznosci: string | null;
	stan: string | null;
}

export interface PermitDecision {
	nazwa: string | null;
	sygnatura: string | null;
	rodzaj: string | null;
	zakres: string | null;
	dataDecyzji: string | null;
}

function epochToIso(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return new Date(value).toISOString().slice(0, 10);
}

function asString(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	const s = String(value).trim();
	return s ? s : null;
}

interface ArcGisFeature {
	attributes?: Record<string, unknown>;
}

async function queryLayer(
	serviceUrl: string,
	layerId: number,
	fields: string,
	lat: number,
	lng: number,
): Promise<Record<string, unknown>[]> {
	const params = new URLSearchParams({
		f: "json",
		where: "1=1",
		geometry: JSON.stringify({
			x: lng,
			y: lat,
			spatialReference: { wkid: 4326 },
		}),
		geometryType: "esriGeometryPoint",
		inSR: "4326",
		spatialRel: "esriSpatialRelIntersects",
		outFields: fields,
		returnGeometry: "false",
	});
	const url = `${serviceUrl}/${layerId}/query?${params.toString()}`;
	const res = await fetch(url, {
		headers: { "User-Agent": "flat-tracker/1.0 (parcel enrichment)" },
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status} for layer ${layerId}`);
	const json = (await res.json()) as { features?: ArcGisFeature[]; error?: unknown };
	if (json.error) throw new Error(`ArcGIS error for layer ${layerId}`);
	return (json.features ?? [])
		.map((f) => f.attributes ?? {})
		.filter((a) => Object.keys(a).length > 0);
}

/** MPZP zones containing the point, with the plan label and designation. */
export async function fetchKrakowMpzpAtPoint(
	lat: number,
	lng: number,
): Promise<MpzpZone[]> {
	const out: MpzpZone[] = [];
	const seen = new Set<string>();
	const pages = await Promise.all(
		MPZP_ZONE_LAYERS.map((layer) =>
			queryLayer(
				MPZP_URL,
				layer,
				"nazwa_mpzp,oznaczenie,rodzaj_ozn,opis_oznac,data_ob",
				lat,
				lng,
			),
		),
	);
	for (const rows of pages) {
		for (const r of rows) {
			const key = `${asString(r.nazwa_mpzp)}|${asString(r.oznaczenie)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				nazwa: asString(r.nazwa_mpzp),
				oznaczenie: asString(r.oznaczenie),
				rodzaj: asString(r.rodzaj_ozn),
				opis: asString(r.opis_oznac),
				dataObowiazywania: epochToIso(r.data_ob),
			});
		}
	}
	return out;
}

/** WZ decisions containing the point. Includes refusals; `rodzaj` says which. */
export async function fetchKrakowWzAtPoint(
	lat: number,
	lng: number,
): Promise<WzDecision[]> {
	const out: WzDecision[] = [];
	const seen = new Set<string>();
	const pages = await Promise.all(
		WZ_LAYERS.map((layer) =>
			queryLayer(
				PLANNING_URL,
				layer,
				"sygnat,nr_dec,rodz_dec,zakr_inw,data_dec,data_ost,stan_spr",
				lat,
				lng,
			),
		),
	);
	for (const rows of pages) {
		for (const r of rows) {
			const key = `${asString(r.sygnat)}|${asString(r.nr_dec)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				sygnatura: asString(r.sygnat),
				numer: asString(r.nr_dec),
				rodzaj: asString(r.rodz_dec),
				zakres: asString(r.zakr_inw),
				dataDecyzji: epochToIso(r.data_dec),
				dataOstatecznosci: epochToIso(r.data_ost),
				stan: asString(r.stan_spr),
			});
		}
	}
	return out;
}

/** Building permits containing the point, newest first. */
export async function fetchKrakowPermitsAtPoint(
	lat: number,
	lng: number,
): Promise<PermitDecision[]> {
	const out: PermitDecision[] = [];
	const seen = new Set<string>();
	const pages = await Promise.all(
		PERMIT_LAYERS.map((layer) =>
			queryLayer(
				PLANNING_URL,
				layer,
				"nazwa_in,sygnat,rodz_dec,zakr_inw,data_dec",
				lat,
				lng,
			),
		),
	);
	for (const rows of pages) {
		for (const r of rows) {
			const key = `${asString(r.sygnat)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				nazwa: asString(r.nazwa_in),
				sygnatura: asString(r.sygnat),
				rodzaj: asString(r.rodz_dec),
				zakres: asString(r.zakr_inw),
				dataDecyzji: epochToIso(r.data_dec),
			});
		}
	}
	return out.sort((a, b) =>
		(b.dataDecyzji ?? "").localeCompare(a.dataDecyzji ?? ""),
	);
}

/** True when the point falls in any published flood hazard polygon. */
export async function fetchKrakowFloodAtPoint(
	lat: number,
	lng: number,
): Promise<{ flood: boolean; layer: number | null }> {
	const pages = await Promise.all(
		FLOOD_LAYERS.map(async (layer) => {
			try {
				return {
					layer,
					rows: await queryLayer(FLOOD_URL, layer, "objectid", lat, lng),
				};
			} catch {
				// Some legacy flood layers are not queryable. Skip them.
				return { layer, rows: [] as Record<string, unknown>[] };
			}
		}),
	);
	const hit = pages.find((p) => p.rows.length > 0);
	if (hit) return { flood: true, layer: hit.layer };
	return { flood: false, layer: null };
}

/** Krakow registry ids start with the city powiat code 1261. */
export function isKrakowParcel(parcelId: string): boolean {
	return parcelId.startsWith("1261");
}
