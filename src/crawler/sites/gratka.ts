import type { Listing } from "../types.ts";
import { formatAddressForGeocode, parseAddressFromText } from "./address.ts";
import { ldOfferAddress, makeLdOfferAdapter, num, str } from "./ldoffer.ts";

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
	const district = str(addr.addressLocality);

	const street = str(addr.streetAddress);
	const desc = str(item.description);
	const parsed = desc ? parseAddressFromText(desc) : null;
	const geocodeAddress = street
		? formatAddressForGeocode(
				street,
				parsed && parsed.street.toLowerCase() === street.toLowerCase()
					? parsed.number
					: undefined,
				district,
			)
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
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

export const gratkaAdapter = makeLdOfferAdapter({
	id: "gratka",
	name: "Gratka - Krakow flats for sale",
	startUrl: "https://gratka.pl/nieruchomosci/mieszkania/krakow",
	pageParam: "page",
	maxRequestsPerCrawl: 30,
	offerToListing,
});
