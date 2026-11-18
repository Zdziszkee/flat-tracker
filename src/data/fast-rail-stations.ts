/**
 * Fast-rail access points for the tracked regions, used by the alert score to
 * measure how far an offer sits from the 200 km/h+ network and from the
 * planned Koleje Dużych Prędkości (KDP) service that reaches Kraków and
 * Katowice via the modernised Centralna Magistrala Kolejowa.
 *
 * Scope, deliberately narrow and factual:
 * - `eip_200`     station served by Express InterCity Premium trains that run
 *                 at 200 km/h on the CMK corridor, or a terminus of such a
 *                 train.
 * - `kdp_2035`    station where the planned KDP service (CPK programme, the
 *                 modernised CMK / spoke concept) is documented to call from
 *                 2035 onwards.
 *
 * The 160 km/h corridors (E30 Kraków–Katowice, line 8 towards Kielce) are NOT
 * in this layer: they carry fast trains but not 200 km/h running, and mixing
 * them in would make the "3 km from fast rail" gate meaningless. Intermediate
 * KDP stops between Katowice and Kraków are not decided as of 2026; when CPK
 * publishes them they belong here as new `kdp_2035` rows, not as approximations
 * of an existing station.
 *
 * Coordinates are the OSM `railway=station` nodes from the same Geofabrik
 * extracts the map already uses (`src/data/region-railways.ts`,
 * `bun run build:railways`), so they agree with the rendered station dots.
 * Sources: https://pl.wikipedia.org/wiki/Kolej_du%C5%BCych_pr%C4%99dko%C5%9Bci_w_Polsce
 * (CMK 200 km/h, EIP destinations) and
 * https://pl.wikipedia.org/wiki/Linia_kolei_du%C5%BCych_pr%C4%99dko%C5%9Bci_Y
 * (KDP reaches Katowice and Kraków through a modernised CMK, not a new line).
 *
 * A wrong or missing entry can only shift a score: it never states a fact
 * about an offer. `confidence: "approx"` marks a stop whose fast-train call is
 * not certain from the published timetable.
 */

export type FastRailService = "eip_200" | "kdp_2035";

export type FastRailConfidence = "documented" | "approx";

export interface FastRailStation {
	id: string;
	name: string;
	city: string;
	region: "malopolskie" | "slaskie";
	lat: number;
	lng: number;
	services: FastRailService[];
	/** First year of the fastest planned service, null when it runs today. */
	kdpYear: number | null;
	confidence: FastRailConfidence;
	sourceUrl: string;
	note: string;
}

const KDP_SOURCE =
	"https://pl.wikipedia.org/wiki/Linia_kolei_du%C5%BCych_pr%C4%99dko%C5%9Bci_Y";
const KDP_200_SOURCE =
	"https://pl.wikipedia.org/wiki/Kolej_du%C5%BCych_pr%C4%99dko%C5%9Bci_w_Polsce";

export const FAST_RAIL_STATIONS: readonly FastRailStation[] = [
	{
		id: "krakow-glowny",
		name: "Kraków Główny",
		city: "Kraków",
		region: "malopolskie",
		lat: 50.06842,
		lng: 19.94789,
		services: ["eip_200", "kdp_2035"],
		kdpYear: 2035,
		confidence: "documented",
		sourceUrl: KDP_SOURCE,
		note: "EIP terminus on the CMK corridor; the documented KDP call in Kraków.",
	},
	{
		id: "katowice",
		name: "Katowice",
		city: "Katowice",
		region: "slaskie",
		lat: 50.25761,
		lng: 19.01715,
		services: ["eip_200", "kdp_2035"],
		kdpYear: 2035,
		confidence: "documented",
		sourceUrl: KDP_SOURCE,
		note: "EIP terminus; the CMK's Katowice branch, documented KDP call.",
	},
	{
		id: "zawiercie",
		name: "Zawiercie",
		city: "Zawiercie",
		region: "slaskie",
		lat: 50.48064,
		lng: 19.42316,
		services: ["eip_200", "kdp_2035"],
		kdpYear: 2035,
		confidence: "documented",
		sourceUrl: KDP_SOURCE,
		note: "Southern end of the CMK 200 km/h section (Olszamowice–Zawiercie).",
	},
	{
		id: "tychy",
		name: "Tychy",
		city: "Tychy",
		region: "slaskie",
		lat: 50.13577,
		lng: 18.96418,
		services: ["eip_200"],
		kdpYear: null,
		confidence: "approx",
		sourceUrl: KDP_200_SOURCE,
		note: "EIP call on the Katowice–Bielsko-Biała run (200 km/h on the CMK leg).",
	},
	{
		id: "bielsko-biala-glowna",
		name: "Bielsko-Biała Główna",
		city: "Bielsko-Biała",
		region: "slaskie",
		lat: 49.82986,
		lng: 19.04532,
		services: ["eip_200"],
		kdpYear: null,
		confidence: "documented",
		sourceUrl: KDP_200_SOURCE,
		note: "EIP destination since December 2015.",
	},
	{
		id: "gliwice",
		name: "Gliwice",
		city: "Gliwice",
		region: "slaskie",
		lat: 50.30116,
		lng: 18.67704,
		services: ["eip_200"],
		kdpYear: null,
		confidence: "documented",
		sourceUrl: KDP_200_SOURCE,
		note: "EIP destination since December 2015.",
	},
];
