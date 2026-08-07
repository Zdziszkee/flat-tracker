import type { Listing } from "../types.ts";
import { makeLdOfferAdapter, num, str } from "./ldoffer.ts";

function offerToListing(offer: Record<string, unknown>): Listing | null {
	const url = str(offer.url);
	const title = str(offer.name);
	const price = num(offer.price);
	if (!url || !title || price === null) return null;

	const item = (offer.itemOffered ?? {}) as Record<string, unknown>;
	const address = (item.address ?? {}) as Record<string, unknown>;
	const size = (item.floorSize ?? {}) as Record<string, unknown>;
	const rooms = num(item.numberOfRooms ?? item.rooms);
	const floor = num(item.floorLevel ?? item.floor);
	const area = num(size.value);

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
		district: str(address.addressLocality),
		lat: null,
		lng: null,
		listedAt: null,
		scrapedAt: new Date().toISOString(),
	};
}

export const morizonAdapter = makeLdOfferAdapter({
	id: "morizon",
	name: "Morizon - Krakow flats for sale",
	startUrl: "https://www.morizon.pl/mieszkania/krakow/",
	pageParam: "page",
	maxRequestsPerCrawl: 30,
	offerToListing,
});
