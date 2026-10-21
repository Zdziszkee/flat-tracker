import { REGIONS } from "../regions.ts";
import type { Listing } from "../types.ts";
import {
	formatAddressForGeocode,
	minedStreetLooksReal,
	parseAddressFromText,
} from "./address.ts";
import { findLdNodes, hasLdType, makeLdGraphAdapter } from "./ldgraph.ts";
import { num, str } from "./ldoffer.ts";
import { propertyTypeFromListingUrl } from "./property-type.ts";

/**
 * Domiporta embeds its results as an ItemList inside an @graph LD+JSON
 * block; each item is a Product/RealEstateListing with an Offer.
 */
export const domiportaAdapter = makeLdGraphAdapter({
	id: "domiporta",
	name: "Domiporta - Małopolska + Śląsk real estate for sale",
	startUrls: REGIONS.flatMap((r) => [
		`https://www.domiporta.pl/mieszkanie/sprzedam/${r.name}`,
		`https://www.domiporta.pl/dom/sprzedam/${r.name}`,
		`https://www.domiporta.pl/dzialka/sprzedam/${r.name}`,
	]),
	maxRequestsPerCrawl: 60,
	// Pagination: ?PageNumber=N (1-based).
	pageParam: "PageNumber",
	findNodes: (nodes) =>
		findLdNodes(
			nodes,
			(node) =>
				hasLdType(node, "RealEstateListing") && typeof node.name === "string",
		),
	toListing: (item, pageUrl) => itemToListing(item, pageUrl),
});

function itemToListing(
	item: Record<string, unknown>,
	pageUrl: string,
): Listing | null {
	const title = str(item.name);
	const url = str(item.url);
	const offer = (item.offers ?? {}) as Record<string, unknown>;
	const price = num(offer.price);
	if (!title || !url || price === null) return null;
	const offered = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const size = (offered.floorSize ?? {}) as Record<string, unknown>;
	const areaM2 = num(size.value);
	const rooms = num(offered.numberOfRooms);
	const structured = (offered.address ?? {}) as Record<string, unknown>;
	const street = str(structured.streetAddress);
	const city = str(structured.addressLocality);

	// No structured address; parse street (+ number) from the title/description.
	const district = extractDistrict(title);
	const description = str(item.description);
	const parsed =
		parseAddressFromText(description) ?? parseAddressFromText(title);
	// The structured address is authoritative for the street and town; title
	// mining may only contribute a housenumber when it agrees on the street.
	const parsedMatchesStreet =
		parsed != null &&
		street != null &&
		parsed.street.trim().toLowerCase() === street.trim().toLowerCase();
	// A lower-case run ("oraz 898") or a sentence fragment is prose, not a
	// street name; only use the mined street when it passes the shared gate.
	const plausibleParsed =
		parsed != null && minedStreetLooksReal(parsed.street) ? parsed : null;
	const address = street
		? formatAddressForGeocode(
				street,
				parsedMatchesStreet ? parsed.number : undefined,
				district,
				city ?? null,
			)
		: plausibleParsed
			? formatAddressForGeocode(
					plausibleParsed.street,
					plausibleParsed.number,
					district,
					city ?? null,
				)
			: city
				? formatAddressForGeocode(city, undefined, null, null)
				: null;

	return {
		source: "domiporta",
		externalId: url.split("/").filter(Boolean).pop() ?? url,
		url,
		title,
		price,
		pricePerM2: areaM2 && areaM2 > 0 ? price / areaM2 : null,
		areaM2,
		rooms,
		floor: null,
		district,
		address,
		description,
		heatingType: null,
		propertyType:
			propertyTypeFromListingUrl(url) ?? propertyTypeFromListingUrl(pageUrl),
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
