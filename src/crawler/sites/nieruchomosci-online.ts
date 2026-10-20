import { REGIONS } from "../regions.ts";
import type { Listing } from "../types.ts";
import { formatAddressForGeocode, parseAddressFromText } from "./address.ts";
import { findLdNodes, makeLdGraphAdapter } from "./ldgraph.ts";
import { num, str } from "./ldoffer.ts";

/**
 * Nieruchomosci-online embeds its results as a CollectionPage LD+JSON
 * block whose mainEntity.offers[0].offers is the listing array.
 */
export const nieruchomosciOnlineAdapter = makeLdGraphAdapter({
	id: "nieruchomosci-online",
	name: "Nieruchomosci-online - Małopolska + Śląsk flats for sale",
	startUrls: REGIONS.map(
		(r) =>
			`https://www.nieruchomosci-online.pl/szukaj.html?3,mieszkanie,sprzedaz,${r.name},,,`,
	),
	maxRequestsPerCrawl: 30,
	// Pagination: &p=N (the first result page has no p param).
	pageParam: "p",
	findNodes: (nodes) =>
		findLdNodes(
			nodes,
			(node) =>
				node["@type"] === "Offer" &&
				typeof node.url === "string" &&
				node.price !== undefined,
		),
	toListing: offerToListing,
});

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
		description: description || null,
		heatingType: null,
		propertyType: null,
		features: null,
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

function extractArea(description: string): number | null {
	const match = description.match(/(\d+[.,]?\d*)\s*m[²2]/i);
	return match ? Number.parseFloat(match[1].replace(",", ".")) : null;
}

function extractRooms(description: string): number | null {
	const match = description.match(/(\d+)-pokojow/i);
	return match ? Number.parseInt(match[1], 10) : null;
}
