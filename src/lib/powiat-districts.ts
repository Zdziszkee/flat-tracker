/**
 * District-string → powiat-name mapping retained for the powiat dataset
 * validator. The choropleth endpoint was removed.
 *
 * Coordinates are the primary assignment path, but ~3% of active listings
 * carry no lat/lng and only a `district` string. Portals put a city, a
 * dzielnica or (for land powiaty) the seat town there, which is not always
 * the powiat name the boundary dataset uses, so the string is normalized and
 * matched: exact alias, exact powiat name, then a conservative prefix match.
 *
 * Two failure modes this module exists to prevent:
 *
 * - a wrong cross-region match: "Tarnowskie Góry" (Śląskie) contains
 *   "tarnowski" (Małopolska), so the prefix heuristic alone files a Śląskie
 *   town into a Małopolska powiat;
 * - a region name passing as a powiat: "śląskie" substring-matches "Piekary
 *   Śląskie". `NOT_A_POWIAT` rejects those before any matching: unassigned
 *   beats wrong.
 *
 * Aliases are cheap to extend, but they must be real: the ones below marked
 * as verified came from querying the district strings of coordinate-less
 * listings in the database rather than from a gazetteer.
 */

/**
 * Lowercase, strip diacritics and punctuation ("Ruda Śląska" -> "rudaslaska").
 *
 * `ł` needs its own fold: Unicode NFD decomposes the accented letters (ą, ę,
 * ó, ś, ż, ź, ć, ń) but not the stroked l, so without this the old `[^a-z0-9]`
 * strip silently *deleted* it ("Sławków" -> "sawkow", "Wodzisław" ->
 * "wodzisaw"): every district string containing ł missed its alias, and the
 * "Małopolskie" guard never matched the name it was written for.
 */
export function normDistrict(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replaceAll("ł", "l")
		.replace(/[^a-z0-9]/g, "");
}

/**
 * District strings that do not normalize onto a powiat name in the dataset.
 * Keys are `normDistrict` output, values are exact powiat names.
 */
export const DISTRICT_ALIASES: Record<string, string> = {
	// małopolskie city powiaty: the dataset entry is the bare city name.
	krakow: "Kraków",
	tarnow: "Tarnów",
	nowysacz: "Nowy Sącz",
	// Seat towns whose stem does not prefix-match the powiat adjective
	// ("wielicki" vs "Wieliczka", "tarnogórski" vs "Tarnowskie Góry").
	olkusz: "olkuski",
	wieliczka: "wielicki",
	zawiercie: "zawierciański",
	raciborz: "raciborski",
	pszczyna: "pszczyński",
	wodzislawslaski: "wodzisławski",
	rydultowy: "wodzisławski",
	// Contains "tarnowski" (powiat tarnowski, Małopolska): without this alias
	// the prefix heuristic files the Śląskie town into Małopolska.
	tarnowskiegory: "tarnogórski",
	czestochowa: "Częstochowa",
	katowice: "Katowice",
	// Towns in a land powiat whose name shares no prefix with it.
	czeladz: "będziński",
	slawkow: "będziński",
	czechowicedziedzice: "bielski",
	ledziny: "bieruńsko-lędziński",
	knurow: "gliwicki",
	orzesze: "mikołowski",
	poreba: "zawierciański",
	lazy: "zawierciański",
	// Verified against the district strings of coordinate-less listings in the
	// database (`select district, count(*) ... where lat is null`).
	wisla: "cieszyński",
	ustron: "cieszyński",
	konczycewielkie: "cieszyński",
	radzionkow: "tarnogórski",
	laziskagorne: "mikołowski",
};

/**
 * Normalized strings that must NEVER resolve to a powiat: a voivodeship name
 * is not a powiat, and a bare region name ("Zagłębie") carries no district
 * information.
 */
export const NOT_A_POWIAT = new Set([
	"malopolskie",
	"malopolska",
	"slaskie",
	"slask",
	"zaglebie",
]);

/**
 * Build the district matcher from the powiat names the boundary dataset
 * actually holds, so an alias can never point at a powiat that is missing.
 */
export function makeDistrictMatcher(
	powiatNames: string[],
): (district: string | null) => string | null {
	const byNorm = new Map<string, string>();
	for (const name of powiatNames) byNorm.set(normDistrict(name), name);
	return (district) => {
		if (!district) return null;
		const key = normDistrict(district);
		if (NOT_A_POWIAT.has(key)) return null;
		const alias = DISTRICT_ALIASES[key];
		if (alias) return alias;
		const exact = byNorm.get(key);
		if (exact) return exact;
		// Conservative prefix match for longer portal strings ("powiat
		// wielicki") and adjective-only forms ("krakowski" is exact already).
		for (const [k, name] of byNorm) {
			if (key.length >= 5 && (key.includes(k) || k.includes(key))) return name;
		}
		return null;
	};
}
