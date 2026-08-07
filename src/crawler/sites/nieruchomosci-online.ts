import type { CheerioAdapter, Listing } from "../types.ts";
import { formatAddressForGeocode, parseAddressFromText } from "./address.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { num, str } from "./ldoffer.ts";

/**
 * Nieruchomosci-online embeds its results as a CollectionPage LD+JSON
 * block whose mainEntity.offers[0].offers is the listing array.
 */
export const nieruchomosciOnlineAdapter: CheerioAdapter = {
	id: "nieruchomosci-online",
	name: "Nieruchomosci-online - Krakow flats for sale",
	kind: "cheerio",
	startUrls: [
		"https://www.nieruchomosci-online.pl/szukaj.html?3,mieszkanie,sprzedaz,,krakow,,,",
	],
	maxRequestsPerCrawl: 30,

	async extractHtml(html, url, enqueue) {
		const nodes = parseLdJson(html);
		// Recursively find every Offer with a URL and price (the feed nests
		// them under CollectionPage -> mainEntity -> offers[0] -> offers).
		const offers = findLdNodes(
			nodes,
			(n) =>
				n["@type"] === "Offer" &&
				typeof n.url === "string" &&
				n.price !== undefined,
		);

		const listings: Listing[] = [];
		for (const offer of offers) {
			const listing = offerToListing(offer);
			if (listing) listings.push(listing);
		}

		// Pagination: &p=N (2-based, p=1 is page 2).
		const current = Number.parseInt(
			new URL(url).searchParams.get("p") ?? "1",
			10,
		);
		const next = new URL(url);
		next.searchParams.set("p", String(current + 1));
		await enqueue([next.toString()]);

		return listings;
	},
};

function offerToListing(offer: Record<string, unknown>): Listing | null {
	const url = str(offer.url);
	const price = num(offer.price);
	const spec = (offer.priceSpecification ?? {}) as Record<string, unknown>;
	const pricePerM2 = num(spec.price);
	if (!url || price === null) return null;

	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const description = str(item.description) ?? "";
	const area = extractArea(description);
	const rooms = extractRooms(description);
	const parsed = parseAddressFromText(description);
	const address = parsed
		? formatAddressForGeocode(parsed.street, parsed.number)
		: null;

	// No title in the feed; derive a readable one from the description.
	const title =
		description.split(".")[0]?.slice(0, 120) || "Mieszkanie na sprzedaż";

	return {
		source: "nieruchomosci-online",
		externalId: url.match(/(\d+)\.html/)?.[1] ?? url,
		url,
		title,
		price,
		pricePerM2,
		areaM2: area,
		rooms,
		floor: null,
		district: null,
		address,
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

function extractArea(description: string): number | null {
	const m = description.match(/(\d+[.,]?\d*)\s*m[²2]/i);
	return m ? Number.parseFloat(m[1].replace(",", ".")) : null;
}

function extractRooms(description: string): number | null {
	const m = description.match(/(\d+)-pokojow/i);
	return m ? Number.parseInt(m[1], 10) : null;
}
