/**
 * Sources whose listings usually carry no portal coordinates, so the map
 * position is produced by our geocoder. nieruchomosci-online is a partial
 * exception: its list rows are address-only, but the detail pass stores the
 * portal's `geo` coordinates for the rows it enriched. A `--reset` for that
 * source wipes those too; scope it to rows outside
 * data/crawler/nieruchomosci-online-details.json if that matters.
 */
export const ADDRESS_ONLY_SOURCES = [
	"morizon",
	"gratka",
	"domiporta",
	"nieruchomosci-online",
	"licytacje-komornik",
	"budujesie",
	"adresowo",
	"sprzedajemy",
] as const;
