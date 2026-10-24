import { REGIONS } from "../regions.ts";
import type { Listing } from "../types.ts";
import { parseAddressFromText } from "./address.ts";
import {
	extractDodaneDates,
	isKrakowOfferUrl,
	ldOfferAddress,
	ldOfferPropertyType,
	makeLdOfferAdapter,
	num,
	offerGeocodeAddress,
	str,
} from "./ldoffer.ts";

function areaFromText(text: string | null): number | null {
	if (!text) return null;
	const match = text.match(/([\d]+(?:[.,]\d+)?)\s*m[²2]/iu);
	if (!match) return null;
	const value = Number.parseFloat(match[1].replace(",", "."));
	return Number.isFinite(value) ? value : null;
}

function roomsFromText(text: string | null): number | null {
	if (!text) return null;
	const match = text.match(/(\d+)\s*(?:pok(?:oi|oje|oj)?|pokoje)/iu);
	return match ? Number.parseInt(match[1], 10) : null;
}

function propertyTypeFromCategory(
	value: string | null,
): Listing["propertyType"] {
	if (!value) return null;
	if (/mieszkan|apartament|kawaler/iu.test(value)) return "apartment";
	if (/\bdom|budynek mieszkaln|bli[źz]niak|szereg/iu.test(value)) {
		return "house";
	}
	if (/dzia[łl]k|grunt/iu.test(value)) return "plot";
	return null;
}

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

function offerToListing(offer: Record<string, unknown>): Listing | null {
	const url = str(offer.url);
	const title = str(offer.name);
	const price = num(offer.price);
	if (!url || !title || price === null) return null;

	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const addr = ldOfferAddress(offer);
	const addressNode = (item.address ?? offer.address ?? {}) as Record<
		string,
		unknown
	>;
	const size = (item.floorSize ?? {}) as Record<string, unknown>;
	const rooms = num(item.numberOfRooms ?? item.rooms) ?? roomsFromText(title);
	const floor = num(item.floorLevel ?? item.floor);
	const desc = str(item.description) ?? str(offer.description);
	const area = num(size.value) ?? areaFromText(title) ?? areaFromText(desc);
	const locality =
		str(addr.addressLocality) ?? str(addressNode.addressLocality);
	const region = str(addressNode.addressRegion);
	const postalCode = str(addressNode.postalCode);
	const category = str(offer.category);
	const seller = (offer.seller ?? {}) as Record<string, unknown>;
	const sellerType = str(seller["@type"]);
	const sellerName = str(seller.name);
	const images = imageInfo(offer.image);
	const additional = pairsToRecord(item.additionalProperty);
	const amenities = pairsToRecord(item.amenityFeature);
	const heating =
		Object.entries(amenities).find(([key]) =>
			/ogrzewanie|heating/iu.test(key),
		)?.[1] ??
		Object.entries(additional).find(([key]) =>
			/ogrzewanie|heating/iu.test(key),
		)?.[1] ??
		null;

	// Street name is structured; a housenumber may appear in the description.
	const street = str(addr.streetAddress) ?? str(addressNode.streetAddress);
	const parsed = desc ? parseAddressFromText(desc) : null;
	const geocodeAddress = offerGeocodeAddress(
		url,
		street,
		parsed && street && parsed.street.toLowerCase() === street.toLowerCase()
			? parsed.number
			: undefined,
		locality,
	);
	const district =
		isKrakowOfferUrl(url) && locality && locality.toLowerCase() !== "kraków"
			? locality
			: null;
	const featureObject = {
		...additional,
		...amenities,
		...(locality ? { city: locality } : {}),
		...(region ? { voivodeship: region } : {}),
		...(street ? { street } : {}),
		...(postalCode ? { postal_code: postalCode } : {}),
		...(num(item.yearBuilt) != null ? { year_built: num(item.yearBuilt) } : {}),
		...(sellerName &&
		sellerType &&
		/organization|realestateagent/iu.test(sellerType)
			? { agency: sellerName }
			: {}),
		...(sellerName && sellerType && /person/iu.test(sellerType)
			? { advertiser_type: "private" }
			: {}),
		...(category ? { category } : {}),
		...(images.count != null ? { image_count: images.count } : {}),
		...(images.primary ? { primary_image: images.primary } : {}),
	};

	return {
		source: "morizon",
		externalId: url.split("/").filter(Boolean).pop() ?? url,
		url,
		title,
		price,
		pricePerM2: price && area ? price / area : null,
		areaM2: area,
		rooms,
		floor: floor !== null ? String(floor) : null,
		district,
		address: geocodeAddress,
		description: desc,
		heatingType: typeof heating === "string" ? heating : null,
		propertyType:
			ldOfferPropertyType(offer) ??
			propertyTypeFromCategory(category) ??
			propertyTypeFromCategory(title),
		features: Object.keys(featureObject).length
			? JSON.stringify(featureObject)
			: null,
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

export const morizonAdapter = makeLdOfferAdapter({
	id: "morizon",
	name: "Morizon - Małopolska + Śląsk real estate for sale",
	startUrls: REGIONS.flatMap((r) => [
		`https://www.morizon.pl/mieszkania/${r.name}/`,
		`https://www.morizon.pl/domy/${r.name}/`,
		`https://www.morizon.pl/dzialki/${r.name}/`,
	]),
	pageParam: "page",
	maxRequestsPerCrawl: 60,
	dateFromHtml: extractDodaneDates,
	offerToListing,
});
