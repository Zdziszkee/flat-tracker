/**
 * Single source of truth for source labels and map colors.
 *
 * Every screen that renders a source name or a map dot imports from here.
 * The previous per-route copies drifted: the listings page lacked the
 * `investmap` label and both pages printed a raw source id for new feeds.
 */

export const SOURCE_LABELS = {
	otodom: "Otodom",
	olx: "OLX",
	morizon: "Morizon",
	gratka: "Gratka",
	domiporta: "Domiporta",
	"nieruchomosci-online": "Nieruchomosci-online",
	rynekpierwotny: "Rynekpierwotny",
	investmap: "Investmap",
	airbnb: "Airbnb",
	booking: "Booking",
	books: "Books (demo)",
	skaleczna: "Skaleczna",
	"licytacje-komornik": "Licytacje komornicze",
	budujesie: "BudujeSie (forum inwestycji)",
} satisfies Record<string, string>;

export const SOURCE_COLORS = {
	otodom: "#2563eb",
	olx: "#f97316",
	morizon: "#16a34a",
	gratka: "#84cc16",
	domiporta: "#a855f7",
	"nieruchomosci-online": "#92400e",
	rynekpierwotny: "#06b6d4",
	investmap: "#0f766e",
	airbnb: "#ff385c",
	booking: "#003580",
	books: "#6d28d9",
	skaleczna: "#d946ef",
	"licytacje-komornik": "#be123c",
	budujesie: "#365314",
} satisfies Record<string, string>;

export type KnownSource = keyof typeof SOURCE_LABELS;

export function sourceLabel(source: string): string {
	return SOURCE_LABELS[source as KnownSource] ?? source;
}
