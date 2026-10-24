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
	adresowo: "Adresowo",
	gethome: "GetHome",
	sprzedajemy: "Sprzedajemy",
	tabelaofert: "TabelaOfert",
	airbnb: "Airbnb",
	booking: "Booking",
	books: "Books (demo)",
	skaleczna: "Skaleczna",
	"licytacje-komornik": "Licytacje komornicze",
	mapalicytacji: "Mapa Licytacji",
	"elicytacje-mf": "eLicytacje KAS",
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
	adresowo: "#ff00aa",
	gethome: "#64748b",
	sprzedajemy: "#facc15",
	tabelaofert: "#fb7185",
	airbnb: "#ff385c",
	booking: "#003580",
	books: "#6d28d9",
	skaleczna: "#d946ef",
	"licytacje-komornik": "#be123c",
	mapalicytacji: "#14532d",
	"elicytacje-mf": "#86198f",
	budujesie: "#365314",
} satisfies Record<string, string>;

export type KnownSource = keyof typeof SOURCE_LABELS;

export function sourceLabel(source: string): string {
	return SOURCE_LABELS[source as KnownSource] ?? source;
}
