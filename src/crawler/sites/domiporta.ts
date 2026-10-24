import { REGIONS } from "../regions.ts";
import type { Listing } from "../types.ts";
import {
	formatAddressForGeocode,
	minedStreetLooksReal,
	parseAddressFromText,
} from "./address.ts";
import { findLdNodes, hasLdType, makeLdGraphAdapter } from "./ldgraph.ts";
import { num, str } from "./ldoffer.ts";
import {
	propertyTypeFromListingUrl,
	propertyTypeFromValue,
} from "./property-type.ts";

function pairsToRecord(value: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!Array.isArray(value)) return out;
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const name = str(record.name);
		if (!name) continue;
		out[name.toLowerCase()] = record.value ?? true;
	}
	return out;
}

function imageInfo(value: unknown): {
	count: number | null;
	primary: string | null;
} {
	if (typeof value === "string") return { count: 1, primary: value };
	if (Array.isArray(value)) {
		const first = value.find(
			(entry): entry is string => typeof entry === "string",
		);
		return { count: value.length, primary: first ?? null };
	}
	return { count: null, primary: null };
}

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
	const structured = (offered.address ?? item.address ?? {}) as Record<
		string,
		unknown
	>;
	const city = str(structured.addressLocality);
	const streetRaw = str(structured.streetAddress);
	const street =
		streetRaw && streetRaw.toLowerCase() !== city?.toLowerCase()
			? streetRaw
			: null;
	const region = str(structured.addressRegion);
	const postalCode = str(structured.postalCode);
	const floor = str(offered.floorLevel ?? item.floorLevel);
	const yearBuilt = num(offered.yearBuilt);
	const amenities = pairsToRecord(offered.amenityFeature);
	const heating = Object.entries(amenities).find(([key]) =>
		/ogrzewanie|heating/iu.test(key),
	)?.[1];
	const seller = (item.seller ?? {}) as Record<string, unknown>;
	const sellerName = str(seller.name);
	const sellerType = str(seller["@type"]);
	const images = imageInfo(item.image);

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
		floor,
		district,
		address,
		description,
		heatingType: typeof heating === "string" ? heating : null,
		propertyType:
			propertyTypeFromValue(offered["@type"]) ??
			propertyTypeFromListingUrl(url) ??
			propertyTypeFromListingUrl(pageUrl),
		features:
			Object.keys(amenities).length ||
			yearBuilt != null ||
			city ||
			sellerName ||
			images.count != null
				? JSON.stringify({
						...amenities,
						...(city ? { city } : {}),
						...(region ? { voivodeship: region } : {}),
						...(postalCode ? { postal_code: postalCode } : {}),
						...(street ? { street } : {}),
						...(yearBuilt != null ? { year_built: yearBuilt } : {}),
						...(floor ? { floor } : {}),
						...(sellerName &&
						sellerType &&
						/organization|realestateagent/iu.test(sellerType)
							? { agency: sellerName }
							: {}),
						...(images.count != null ? { image_count: images.count } : {}),
						...(images.primary ? { primary_image: images.primary } : {}),
					})
				: null,
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
