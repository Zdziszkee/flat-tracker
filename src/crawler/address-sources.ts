/**
 * Sources whose listings carry no portal coordinates, so the map position is
 * produced entirely by our geocoder. Re-anchoring these from scratch is safe:
 * none of their stored lat/lng came from the portal itself.
 */
export const ADDRESS_ONLY_SOURCES = [
	"morizon",
	"gratka",
	"domiporta",
	"nieruchomosci-online",
	"licytacje-komornik",
	"budujesie",
] as const;
