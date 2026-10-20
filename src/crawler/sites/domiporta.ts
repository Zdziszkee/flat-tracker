import { REGIONS } from "../regions.ts";
import type { Listing } from "../types.ts";
import { formatAddressForGeocode, parseAddressFromText } from "./address.ts";
import { findLdNodes, hasLdType, makeLdGraphAdapter } from "./ldgraph.ts";
import { num, str } from "./ldoffer.ts";

/**
 * Domiporta embeds its results as an ItemList inside an @graph LD+JSON
 * block; each item is a Product/RealEstateListing with an Offer.
 */
export const domiportaAdapter = makeLdGraphAdapter({
	id: "domiporta",
	name: "Domiporta - Małopolska + Śląsk flats for sale",
	startUrls: REGIONS.map(
		(r) => `https://www.domiporta.pl/mieszkanie/sprzedam/${r.name}`,
	),
	maxRequestsPerCrawl: 40,
	// Pagination: ?PageNumber=N (1-based).
	pageParam: "PageNumber",
	findNodes: (nodes) =>
		findLdNodes(
			nodes,
			(node) =>
				hasLdType(node, "RealEstateListing") && typeof node.name === "string",
		),
	toListing: itemToListing,
});

function itemToListing(item: Record<string, unknown>): Listing | null {
	const title = str(item.name);
	const url = str(item.url);
	const offer = (item.offers ?? {}) as Record<string, unknown>;
	const price = num(offer.price);
	if (!title || !url || price === null) return null;

	// No structured address; parse street (+ number) from the title/description.
	const district = extractDistrict(title);
	const description = str(item.description);
	const parsed =
		parseAddressFromText(description) ?? parseAddressFromText(title);
	const address = parsed
		? formatAddressForGeocode(parsed.street, parsed.number, district)
		: null;

	return {
		source: "domiporta",
		externalId: url.split("/").filter(Boolean).pop() ?? url,
		url,
		title,
		price,
		pricePerM2: null,
		areaM2: null,
		rooms: null,
		floor: null,
		district,
		address,
		description,
		heatingType: null,
		propertyType: null,
		features: null,
		lat: null,
		lng: null,
		listedAt: str(item.datePosted),
		scrapedAt: new Date().toISOString(),
	};
}

/** Titles look like "... Kraków Prądnik Biały, Prądnik Biały: Mackiewicza". */
function extractDistrict(title: string): string | null {
	const match = title.match(/Krak[oó]w\s+([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż-]+)/);
	return match ? match[1] : null;
}
