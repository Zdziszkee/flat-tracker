/**
 * TERYT4 -> readable powiat name for the RCN analytics endpoints.
 *
 * The RCN importer stores the powiat prefix in `parcel_id`; the chart labels
 * come from here. `regionPowiats` owns the boundary geometry and the canonical
 * names, so `validate-market-charts` asserts that every entry here exists in
 * that dataset.
 */
export const POWIAT_NAMES: Record<string, string> = {
	"1201": "bocheński",
	"1202": "brzeski",
	"1203": "chrzanowski",
	"1204": "dąbrowski",
	"1205": "gorlicki",
	"1206": "krakowski",
	"1207": "limanowski",
	"1208": "miechowski",
	"1209": "myślenicki",
	"1210": "nowosądecki",
	"1211": "nowotarski",
	"1212": "olkuski",
	"1213": "oświęcimski",
	"1214": "proszowicki",
	"1215": "suski",
	"1216": "tarnowski",
	"1217": "tatrzański",
	"1218": "wadowicki",
	"1219": "wielicki",
	"1261": "Kraków",
	"1262": "Nowy Sącz",
	"1263": "Tarnów",
	// Śląskie (TERYT 24xx). Verified from the average coordinates of each
	// `parcel_id` prefix against the powiat boundary dataset.
	"2401": "będziński",
	"2402": "bielski",
	"2403": "cieszyński",
	"2404": "częstochowski",
	"2405": "gliwicki",
	"2406": "kłobucki",
	"2407": "lubliniecki",
	"2408": "mikołowski",
	"2409": "myszkowski",
	"2410": "pszczyński",
	"2411": "raciborski",
	"2412": "rybnicki",
	"2413": "tarnogórski",
	"2414": "bieruńsko-lędziński",
	"2415": "wodzisławski",
	"2416": "zawierciański",
	"2417": "żywiecki",
	"2461": "Bielsko-Biała",
	"2462": "Bytom",
	"2463": "Chorzów",
	"2464": "Częstochowa",
	"2465": "Dąbrowa Górnicza",
	"2466": "Gliwice",
	"2467": "Jastrzębie-Zdrój",
	"2468": "Jaworzno",
	"2469": "Katowice",
	"2470": "Mysłowice",
	"2471": "Piekary Śląskie",
	"2472": "Ruda Śląska",
	"2473": "Rybnik",
	"2474": "Siemianowice Śląskie",
	"2475": "Sosnowiec",
	"2476": "Świętochłowice",
	"2477": "Tychy",
	"2478": "Zabrze",
	"2479": "Żory",
};

const TERYT_BY_NAME = new Map(
	Object.entries(POWIAT_NAMES).map(([teryt, name]) => [name, teryt]),
);

export function powiatName(teryt: string): string | undefined {
	return POWIAT_NAMES[teryt];
}

/** Reverse lookup, built once instead of scanning the map per chart row. */
export function terytForPowiat(name: string): string | undefined {
	return TERYT_BY_NAME.get(name);
}
