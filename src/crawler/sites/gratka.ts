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

function offerToListing(offer: Record<string, unknown>): Listing | null {
	const url = str(offer.url);
	const title = str(offer.name);
	const price = num(offer.price);
	if (!url || !title || price === null) return null;

	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const addr = ldOfferAddress(offer);
	const size = (item.floorSize ?? {}) as Record<string, unknown>;
	const rooms = num(item.numberOfRooms ?? item.rooms);
	const floor = num(item.floorLevel ?? item.floor);
	const area = num(size.value);
	const locality = str(addr.addressLocality);

	const street = str(addr.streetAddress);
	const desc = str(item.description);
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

	return {
		source: "gratka",
		// Gratka URLs end with /ob/<id>.
		externalId: url.match(/\/ob\/(\d+)/)?.[1] ?? url,
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
		heatingType: null,
		propertyType: ldOfferPropertyType(offer),
		features: null,
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

export const gratkaAdapter = makeLdOfferAdapter({
	id: "gratka",
	name: "Gratka - Małopolska + Śląsk real estate for sale",
	startUrls: REGIONS.flatMap((r) => [
		`https://gratka.pl/nieruchomosci/mieszkania/${r.name}`,
		`https://gratka.pl/nieruchomosci/domy/${r.name}`,
		`https://gratka.pl/nieruchomosci/dzialki-grunty/${r.name}`,
	]),
	pageParam: "page",
	maxRequestsPerCrawl: 60,
	dateFromHtml: extractDodaneDates,
	offerToListing,
});
