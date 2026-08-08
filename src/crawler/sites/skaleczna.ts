import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";

/**
 * Skałeczna (Koneser Group) — a private renovation investment on
 * Kazimierz, Kraków (Skałeczna 1/3/5/7). The offer page is a static
 * WordPress table: one row per unit with building, floor, unit id, area,
 * promo/regular price and status (Wolne / Zarezerwowane / Sprzedane).
 *
 * Only units with status "Wolne" (available) are kept. Units carry no
 * coordinates — `npm run geocode-addresses` anchors them via the local
 * OSM index (Skałeczna is well mapped).
 */

const OFFER_URL = "https://skaleczna.pl/oferta/";

/** Rows in the offer table that describe a real unit. */
const UNIT_SELECTOR = "#offer-table tbody tr:not(.sold-floor-row)";

/** Parse "49,50 m2" -> 49.5 (null when absent). */
function areaM2(text: string | undefined): number | null {
	if (!text) return null;
	const m = text.replace(/\s/g, "").match(/(\d+[,.]\d+|\d+)/);
	if (!m) return null;
	const v = Number.parseFloat(m[1].replace(",", "."));
	return Number.isFinite(v) ? v : null;
}

/** Parse "549 000 PLN" -> 549000 (null when absent). */
function pricePln(text: string | undefined): number | null {
	if (!text) return null;
	const digits = text.replace(/\s/g, "").match(/\d+/);
	if (!digits) return null;
	const v = Number.parseInt(digits[0], 10);
	return Number.isFinite(v) ? v : null;
}

export const skalecznaAdapter: CheerioAdapter = {
	id: "skaleczna",
	name: "Skałeczna (Koneser Group) - Kazimierz",
	kind: "cheerio",
	startUrls: [OFFER_URL],
	maxRequestsPerCrawl: 2,

	listingSelector: UNIT_SELECTOR,
	parseListingCard($: CheerioSelection, el: unknown): Listing | null {
		const cells = $(el as never).find("td");
		const building = cells
			.eq(0)
			.text()
			.replace(/\u00a0/g, " ")
			.trim();
		const floor = cells.eq(1).text().trim();
		const unit = cells.eq(2).text().trim();
		const area = areaM2(cells.eq(3).text());
		const promoPrice = pricePln(cells.eq(8).text());
		const regularPrice = pricePln(cells.eq(9).text());
		const status = cells.eq(10).text().trim();

		if (!unit || status !== "Wolne") return null;

		const price = promoPrice ?? regularPrice;
		return {
			source: "skaleczna",
			externalId: `${building}-${floor}-${unit}`,
			url: OFFER_URL,
			title: `${building}, ${unit} · ${area ? `${area.toLocaleString("pl-PL")} m²` : "mieszkanie"} (Skałeczna, Kazimierz)`,
			price,
			pricePerM2: price && area ? price / area : null,
			areaM2: area,
			rooms: null,
			floor,
			district: "Kazimierz",
			address: `${building}, 31-065 Kraków`,
			lat: null,
			lng: null,
			listedAt: null,
			scrapedAt: new Date().toISOString(),
		};
	},
};
