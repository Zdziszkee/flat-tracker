import type { PropertyKind } from "#/lib/property-kind";

/**
 * Map the type labels portals actually publish to the three UI kinds.
 *
 * Adapters now crawl flats, houses and plots from the same source, so a row
 * must carry its own kind evidence: the old "this source only lists flats"
 * default in `propertyKindOf` is no longer true for the sale feeds. The
 * values arrive as schema.org types ("House", "Place", "Accommodation"),
 * portal enums ("HOUSE", "TERRAIN", "FLAT") or Polish labels ("mieszkanie",
 * "działka").
 */
const TYPE_VALUES: Record<string, PropertyKind> = {
	accommodation: "apartment",
	apartment: "apartment",
	apartament: "apartment",
	flat: "apartment",
	kawalerka: "apartment",
	mieszkanie: "apartment",
	house: "house",
	dom: "house",
	domy: "house",
	domu: "house",
	terrain: "plot",
	place: "plot",
	plot: "plot",
	land: "plot",
	dzialka: "plot",
	działka: "plot",
	dzialki: "plot",
	grunt: "plot",
	grunty: "plot",
};

export function propertyTypeFromValue(value: unknown): PropertyKind | null {
	if (Array.isArray(value)) {
		for (const entry of value) {
			const kind = propertyTypeFromValue(entry);
			if (kind) return kind;
		}
		return null;
	}
	if (typeof value !== "string") return null;
	return TYPE_VALUES[value.trim().toLowerCase()] ?? null;
}

/**
 * Type evidence from a listing URL slug, for feeds whose schema.org nodes
 * label every item the same way (domiporta/nieruchomosci-online use
 * "Accommodation" for a flat, a house and a plot alike). Portals put the
 * category in the first slug segment: "/sprzedaz-dom-...", "/dom,na-sprzedaz/",
 * "/nieruchomosci/dzialka-...". Match whole segments so a street such as
 * "Domowa" cannot be mistaken for a house.
 */
export function propertyTypeFromListingUrl(url: string): PropertyKind | null {
	let path: string;
	try {
		path = new URL(url, "https://placeholder.invalid").pathname;
	} catch {
		return null;
	}
	const normalized = path
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
	const segment = (pattern: string) =>
		new RegExp(`(?:^|[/_,-])${pattern}(?:$|[/_,.-])`, "u").test(normalized);
	// Houses first: a house slug may also mention its plot ("dom-z-dzialka").
	if (segment("(?:dom|domy|domu|domek|domki|domkow)")) return "house";
	if (segment("(?:dzialk(?:a|i|e|ek)?|grunt(?:y|u|ow)?)")) return "plot";
	if (
		segment(
			"(?:mieszkan(?:ie|ia|iem)?|apartament(?:y|ow|u)?|kawaler(?:ka|ki)?)",
		)
	) {
		return "apartment";
	}
	return null;
}
