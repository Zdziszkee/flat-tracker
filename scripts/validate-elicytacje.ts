import assert from "node:assert/strict";

import {
	type ElicytacjeRecord,
	recordToListing,
} from "../src/crawler/sites/elicytacje-mf.ts";

/**
 * Pins the eLicytacje KAS mapping: category -> property kind, area units
 * (m² vs ha), the address format the geocoder expects, the wadium/auction
 * attributes and the expired-auction guard. Run with
 * `bun run validate:elicytacje`.
 */

const base: ElicytacjeRecord = {
	uuid: "f6cad394-46ce-4c06-8830-a403bba871bf",
	title: "Spółdzielcze własnościowe prawo do lokalu mieszkalnego Kraków ul. Sucha",
	publicationDateTime: "2026-10-21T11:08:00.14Z",
	saleBeginDateTime: "2099-12-10T09:00:00Z",
	saleEndDateTime: "2099-12-17T09:00:00Z",
	announcementTypeGroupCode: "LICELENIER",
	electronicStateCode: "WAITING",
	announcementNo: "7130.26",
	authorityName: "Urząd Skarbowy Kraków - Podgórze",
	startingPrice: 278775,
	depositAmount: 37170,
	depositDueDate: "2099-12-08",
	auctionSequenceCode: "1L",
	voivodeshipCode: "12",
	city: "KRAKÓW",
	streetName: "Sucha",
	streetNo: "1A",
	apartmentNo: "17",
	zipCode: "30-601",
	additionalInfo: null,
	categoryName: "Mieszkania",
	description: "Na sprzedaż 1/2 udziału w lokalu mieszkalnym.",
	parameters: [
		{ name: "Liczba pokoi", value: "3" },
		{ name: "Powierzchnia użytkowa (m²)", value: "63,86" },
		{ name: "Piętro", value: "Parter" },
	],
};

const flat = recordToListing(base);
assert.ok(flat, "a future flat auction maps to a listing");
assert.equal(flat.propertyType, "apartment");
assert.equal(flat.areaM2, 63.86);
assert.equal(flat.rooms, 3);
assert.equal(flat.floor, "Parter");
assert.equal(flat.price, 278775);
assert.equal(Math.round(flat.pricePerM2 ?? 0), 4365);
assert.equal(flat.address, "Sucha 1A/17, 30-601 KRAKÓW");
assert.equal(flat.listedAt, "2026-10-21T11:08:00.14Z");
assert.equal(
	flat.url,
	"https://elicytacje.mf.gov.pl/auction/announcements/f6cad394-46ce-4c06-8830-a403bba871bf",
);
const flatFeatures = JSON.parse(flat.features ?? "{}") as Record<string, unknown>;
assert.equal(flatFeatures.auction_type, "skarbowe");
assert.equal(flatFeatures.seller, "Urząd Skarbowy Kraków - Podgórze");
assert.equal(flatFeatures.wadium, 37170);
assert.equal(flatFeatures.wadium_due, "2099-12-08");
assert.equal(flatFeatures.auction_round, "1L");
assert.equal(flatFeatures.city, "KRAKÓW");
assert.equal(flatFeatures.voivodeship, "małopolskie");
assert.equal(flatFeatures.postal_code, "30-601");
assert.equal(flatFeatures.street, "Sucha");
assert.equal(flatFeatures.street_number, "1A/17");

// Land area is reported in hectares; the map/table use m². Built plots are
// houses (the category says "Grunty", the title names the dwelling).
const plot = recordToListing({
	...base,
	uuid: "plot",
	title: "Nieruchomość gruntowa niezabudowana",
	categoryName: "Grunty",
	parameters: [
		{
			name: "Łączna powierzchnia gruntu (wszystkich działek) (ha)",
			value: "0,8656",
		},
	],
});
assert.ok(plot);
assert.equal(plot.propertyType, "plot");
assert.equal(plot.areaM2, 8656);

// "ar" is 100 m² (the portal mixes hectares, ares and m² in the same field).
const ares = recordToListing({
	...base,
	uuid: "ares",
	title: "Działka gruntowa 32,26 ara",
	categoryName: "Grunty",
	parameters: [],
});
assert.ok(ares);
assert.equal(ares.areaM2, 3226);

const builtPlot = recordToListing({
	...base,
	uuid: "built-plot",
	title:
		"Nieruchomość gruntowa zabudowana domem mieszkalnym w zabudowie szeregowej",
	categoryName: "Grunty",
	parameters: [],
});
assert.ok(builtPlot);
assert.equal(builtPlot.propertyType, "house");

// Commercial units stay untyped so they appear only under "Wszystkie".
const commercial = recordToListing({
	...base,
	uuid: "commercial",
	categoryName: "Lokale użytkowe, hale i magazyny",
	parameters: [],
});
assert.ok(commercial);
assert.equal(commercial.propertyType, null);

// Valuation notices carry no starting price and get an honest label.
const notice = recordToListing({
	...base,
	uuid: "notice",
	announcementTypeGroupCode: "OSZNELNIER",
	startingPrice: null,
	depositAmount: null,
	auctionSequenceCode: null,
});
assert.ok(notice);
assert.equal(notice.price, null);
assert.equal(notice.title.startsWith("Obwieszczenie KAS: "), true);

// Ended auctions are noise on an opportunity map.
const expired = recordToListing({
	...base,
	uuid: "expired",
	saleEndDateTime: "2020-01-01T00:00:00Z",
});
assert.equal(expired, null);

// Area mining fallback when the parameter list is empty.
const fromDescription = recordToListing({
	...base,
	uuid: "from-description",
	parameters: [],
	description: "Nieruchomość gruntowa o powierzchni 0,2550 ha.",
});
assert.ok(fromDescription);
assert.equal(fromDescription.areaM2, 2550);

// A share's price covers only the fraction, so price/m² is left unset.
const share = recordToListing({
	...base,
	uuid: "share",
	title: "Udział (1/2) w lokalu mieszkalnym Kraków ul. Sucha",
});
assert.ok(share);
assert.equal(share.pricePerM2, null);
assert.equal(
	(JSON.parse(share.features ?? "{}") as Record<string, unknown>).share,
	true,
);

console.log("validate:elicytacje ok (9 cases)");
