/**
 * The three property kinds the UI filters by: dom / mieszkanie / działka.
 *
 * Most feeds never state a type — the sale portals are /mieszkania/ feeds by
 * construction and komornik sells everything from flats to bare plots — so
 * the kind is derived here, once, from the evidence a row actually carries:
 * the portal's own `propertyType` (airbnb fills it), the source's feed
 * semantics, and honest title hints ("działka", "nieruchomość gruntowa",
 * "budynek mieszkalny"). Rows with no evidence stay `null` and appear only
 * under "Wszystkie" — a guess would misfile them.
 */

export type PropertyKind = "apartment" | "house" | "plot";

/** Airbnb room types that are flats/living units. */
const APARTMENT_TYPES = new Set([
	"apartment",
	"serviced_apartment",
	"aparthotel",
	"condominium",
	"loft",
]);

/** Airbnb room types that are houses/homes (incl. cottage-industry variants). */
const HOUSE_TYPES = new Set([
	"house",
	"cabin",
	"cottage",
	"chalet",
	"tiny_house",
	"bungalow",
	"townhouse",
	"villa",
	"vacation_home",
	"farmhouse",
	"farmstay",
	"ranch",
	"barn",
	"hut",
	"treehouse",
	"earthhouse",
	"dome",
	"houseboat",
	"shepherds_hut",
	"shipping_container",
	"tipi",
	"tower",
	"castle",
	"cave",
	"nature_eco_lodge",
	"casa_particular",
	"shepherds hut",
]);

/**
 * Sources whose feeds are apartments-only (`/mieszkania/` URLs): their rows
 * are flats unless the title proves otherwise (komornik-style re-listings do
 * not occur here).
 */
const APARTMENT_FEED_SOURCES = new Set([
	"otodom",
	"otodom-rent",
	"olx",
	"morizon",
	"gratka",
	"domiporta",
	"nieruchomosci-online",
	"rynekpierwotny",
]);

/** Plots/land, in the words the portals and auction notices actually use. */
const PLOT_RE =
	/dzia[łl]k|nieruchomo[śćs]c gruntow|grunt(?:owa|owej|owe|owych)?\s+niezabudow/i;

/** Built-up land and houses. */
const HOUSE_RE =
	/budynek mieszkalny|dom(?:y|ek)? (?:jednorodzinny|wolnostoj|w zabudowie)|bli[źni]niak|segment(?:y|ów)?\b|domek letniskow/i;

interface KindEvidence {
	source: string;
	title: string;
	propertyType?: string | null;
	externalId?: string;
}

export function propertyKindOf(row: KindEvidence): PropertyKind | null {
	const t = row.propertyType?.toLowerCase() ?? "";
	const title = row.title ?? "";

	// 0. Investments are their own thing (budujesie threads, investmap
	// `inv-` stand-ins): never a flat/house/plot, whatever the title says.
	if (row.source === "budujesie") return null;
	if (row.source === "investmap" && row.externalId?.startsWith("inv-"))
		return null;

	// 1. The portal told us the type.
	if (t === "inwestycja") return null;
	if (APARTMENT_TYPES.has(t)) return "apartment";
	if (HOUSE_TYPES.has(t)) return "house";
	if (t === "działka" || t === "dzialka" || t === "plot" || t === "land")
		return "plot";

	// 2. Built-up land counts as a house; bare land as a plot.
	if (PLOT_RE.test(title)) {
		return /grunt(?:owa|owej|owe|owych)?\s+zabudow/i.test(title)
			? "house"
			: "plot";
	}
	if (HOUSE_RE.test(title)) return "house";
	const flatTitle = /\bmieszkanie|\bapartament|\bpok[óo]j do wynaj/i.test(
		title,
	);
	if (flatTitle) return "apartment";

	// 3. Feed semantics: the /mieszkania/ sale portals default to flats;
	// investmap's flat rows (not the `inv-` investment stand-ins) are flats.
	if (row.source === "investmap" && !row.externalId?.startsWith("inv-"))
		return "apartment";
	if (APARTMENT_FEED_SOURCES.has(row.source)) return "apartment";

	// 4. No evidence: stay untyped rather than misfile.
	return null;
}

export const PROPERTY_KIND_LABELS: Record<PropertyKind | "all", string> = {
	all: "Wszystkie",
	apartment: "Mieszkanie",
	house: "Dom",
	plot: "Działka",
};
