/**
 * Pin the shared listing-view behavior that the map and the listings table
 * now both consume: time windows, facets, feature parsing, and formatting.
 * Run with `bun run validate:listing-view`.
 */
import {
	parseListingFeatures,
	filterListings,
	listingFacets,
	matchesTimeWindow,
} from "../src/lib/listing-features.ts";
import { propertyKindOf } from "../src/lib/property-kind.ts";
import { formatUtilities, realizationCaption } from "../src/lib/format.ts";
import {
	extractDodaneDates,
	offerGeocodeAddress,
} from "../src/crawler/sites/ldoffer.ts";
import {
	propertyTypeFromListingUrl,
	propertyTypeFromValue,
} from "../src/crawler/sites/property-type.ts";
import { popupHtml } from "../src/components/map/popups.ts";
import type { ApiListing } from "../src/components/map/types.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

const now = Date.now();
const recent = new Date(now - 2 * 3_600_000).toISOString();
const old = new Date(now - 90 * 86_400_000).toISOString();

const budujesie = {
	source: "budujesie",
	externalId: "t-1",
	listedAt: old,
	firstSeenAt: old,
	propertyKind: null,
	offerType: "sale",
};
const recentBudujesie = {
	source: "budujesie",
	externalId: "t-2",
	listedAt: recent,
	firstSeenAt: recent,
	propertyKind: null,
	offerType: "sale",
};
const investmapStandIn = {
	source: "investmap",
	externalId: "inv-42",
	listedAt: old,
	firstSeenAt: old,
	propertyKind: null,
	offerType: "sale",
};
const investmapFlat = {
	source: "investmap",
	externalId: "flat-1",
	listedAt: old,
	firstSeenAt: old,
	propertyKind: "apartment" as const,
	offerType: "sale",
};
const oldOtodom = {
	source: "otodom",
	externalId: "o-1",
	listedAt: old,
	firstSeenAt: old,
	propertyKind: "apartment" as const,
	offerType: "sale",
};
const recentOlx = {
	source: "olx",
	externalId: "x-1",
	listedAt: recent,
	firstSeenAt: recent,
	propertyKind: "house" as const,
	offerType: "sale",
};
const recentRent = {
	source: "olx",
	externalId: "x-2",
	listedAt: recent,
	firstSeenAt: recent,
	propertyKind: "apartment" as const,
	offerType: "long_term_rental",
};
const undated = {
	source: "morizon",
	externalId: "m-1",
	listedAt: null,
	firstSeenAt: null,
	propertyKind: "apartment" as const,
	offerType: "sale",
};

check(!matchesTimeWindow(budujesie, 1), "old budujesie thread is hidden by the 24h window");
check(matchesTimeWindow(recentBudujesie, 7), "recent budujesie thread survives the 7d window");
check(!matchesTimeWindow(investmapStandIn, 1), "old investmap stand-in is hidden by the 24h window");
check(!matchesTimeWindow(investmapFlat, 1), "old investmap flat is hidden by the 24h window");
check(matchesTimeWindow(recentOlx, 7), "recent offer survives the 7d window");
check(!matchesTimeWindow(oldOtodom, 7), "old offer is hidden by the 7d window");
check(!matchesTimeWindow(undated, 30), "a row without any added date is hidden by a window");

const all = [
	budujesie,
	recentBudujesie,
	investmapStandIn,
	investmapFlat,
	oldOtodom,
	recentOlx,
	recentRent,
	undated,
];
const facets = listingFacets(all, 1);
check(facets.total === 3, "facets count only rows inside the window");
check(
	facets.bySource.get("budujesie") === 1,
	"facets count the recent budujesie thread and drop the old one",
);
check(
	(facets.bySource.get("investmap") ?? 0) === 0,
	"facets exclude old investmap rows",
);
check(facets.byKind.get("house") === 1, "facets count house");

const saleOnly = filterListings(all, {
	source: "all",
	days: 1,
	kind: "all",
	offerType: "sale",
});
check(saleOnly.length === 2, "offerType sale excludes the rental");
check(!saleOnly.some((r) => r.externalId === "x-2"), "sale filter drops rental");

const houseOnly = filterListings(all, {
	source: "all",
	days: 0,
	kind: "house",
	offerType: "all",
});
check(houseOnly.length === 1 && houseOnly[0]?.externalId === "x-1", "kind filter works");

const parsedBud = parseListingFeatures(
	JSON.stringify({
		replies: 12,
		views: 3400,
		lastPostAt: "2026-09-01",
		posts: [{ author: "anna", at: "2026-09-01", text: "opis" }],
	}),
);
check(parsedBud.budujesie?.replies === 12, "parses budujesie replies");
check(parsedBud.budujesie?.posts[0]?.text === "opis", "parses budujesie posts");

const parsedInv = parseListingFeatures(JSON.stringify({ investment_id: 42 }));
check(parsedInv.investmap?.investmentId === "42", "parses investmap investment id");

const parsedAir = parseListingFeatures(
	JSON.stringify({ amenities: ["wifi", 7, "kitchen"] }),
);
check(
	parsedAir.airbnb?.amenities.join(",") === "wifi,kitchen",
	"parses and filters airbnb amenities",
);

const malformed = parseListingFeatures("{not json");
check(malformed.budujesie === null && malformed.airbnb === null, "malformed JSON degrades");

check(formatUtilities('{"czynsz":500,"ogrzewanie":120}') === "Opłaty: czynsz 500 zł · ogrz. 120 zł", "formats utilities");
check(formatUtilities("nope") === "", "malformed utilities degrade");
check(realizationCaption("I kw. 2027", "2027-01-01").includes("w budowie"), "future realization is in progress");

check(
	propertyKindOf({ source: "otodom", title: "3 pokoje", propertyType: "house" }) ===
		"house",
	"classifier trusts an explicit house type",
);
check(
	propertyKindOf({
		source: "nieruchomosci-online",
		title: "Działka budowlana",
		propertyType: "plot",
	}) === "plot",
	"classifier trusts an explicit plot type",
);
check(
	propertyKindOf({ source: "investmap", title: "Dom", propertyType: "dom" }) ===
		"house",
	"classifier maps the Polish house label",
);
check(
	propertyTypeFromValue("TERRAIN") === "plot",
	"maps otodom TERRAIN to plot",
);
check(
	propertyTypeFromValue("Place") === "plot",
	"maps schema.org Place to plot",
);
check(
	propertyTypeFromListingUrl(
		"https://www.morizon.pl/oferta/sprzedaz-dzialka-krakow-zmujdzka-676m2-mzn1",
	) === "plot",
	"plot kind from a morizon slug",
);
check(
	propertyTypeFromListingUrl(
		"https://www.domiporta.pl/nieruchomosci/sprzedam-dom-wokowice-os-nowe-168m2/1",
	) === "house",
	"house kind from a domiporta slug",
);
check(
	propertyTypeFromListingUrl(
		"https://krakow.nieruchomosci-online.pl/mieszkanie-w-apartamentowcu,wysoki-standard/1.html",
	) === "apartment",
	"flat kind from a nieruchomosci-online slug",
);
check(
	propertyTypeFromListingUrl(
		"https://www.morizon.pl/oferta/sprzedaz-dom-krakow-z-duza-dzialka-120m2-mzn1",
	) === "house",
	"a house slug mentioning its plot stays a house",
);
check(
	propertyTypeFromListingUrl("https://example.test/oferta/ul-domowa-12") === null,
	"a street name containing 'dom' is not a house",
);
const dodane = extractDodaneDates(
	'<a href="/oferta/sprzedaz-dom-x">Dom</a><div>Dodane: 2026.08.26</div>',
);
check(
	dodane.get("/oferta/sprzedaz-dom-x") === "2026-08-26T00:00:00",
	"parses morizon/gratka card posting dates",
);
check(
	offerGeocodeAddress(
		"https://www.morizon.pl/oferta/sprzedaz-mieszkanie-krakow-mistrzejowice-x",
		"Mackiewicza",
		"12",
		"Mistrzejowice",
	) === "Mackiewicza 12, Mistrzejowice, Kraków",
	"Kraków district address keeps the city",
);
check(
	offerGeocodeAddress(
		"https://gratka.pl/nieruchomosci/dom-wielicki-niepolomice-wola-zabierzowska/ob/1",
		"Wola Zabierzowska",
		undefined,
		"Niepołomice",
	) === "Wola Zabierzowska, Niepołomice",
	"out-of-town house address uses its own town",
);
check(
	offerGeocodeAddress(
		"https://www.morizon.pl/oferta/sprzedaz-dzialka-bochenski-lipnica-x",
		null,
		undefined,
		"Lipnica Dolna",
	) === "Lipnica Dolna",
	"out-of-town plot falls back to the town, not Kraków",
);
check(
	offerGeocodeAddress(
		"https://www.morizon.pl/oferta/sprzedaz-mieszkanie-krakow-x",
		null,
		undefined,
		"Kraków",
	) === "Kraków",
	"town-level Kraków address is not duplicated",
);

const popupBase = {
	id: 1,
	source: "otodom",
	externalId: "popup-1",
	url: "https://example.com/offer",
	title: "Mieszkanie 3 pokoje",
	price: 750_000,
	pricePerM2: 15_000,
	areaM2: 50,
	rooms: 3,
	floor: "3",
	district: null,
	address: "ul. Długa 5, Kraków",
	lat: null,
	lng: null,
	listedAt: "2026-10-01T00:00:00.000Z",
	firstSeenAt: "2026-10-01T00:00:00.000Z",
	heatingType: "miejskie",
	propertyType: "apartment",
	propertyKind: "apartment",
	features: "{}",
	buildingId: null,
	buildingAddress: null,
	mapLat: null,
	mapLng: null,
	offerType: "sale",
	transactionStats: null,
} as unknown as ApiListing;

const richPopup = popupHtml({
	...popupBase,
	attributes: {
		city: "Kraków",
		street: "Długa",
		streetNumber: "5",
		buildYear: 2010,
		buildingMaterial: "cegła",
		market: "secondary",
		condition: "good",
		hasBalcony: true,
		hasElevator: true,
		adminFee: 706,
		deposit: 3500,
		advertiserType: "agency",
		agencyName: "Biuro X",
		portalStatus: "reserved",
	},
});
check(
	richPopup.includes("Rok budowy") && richPopup.includes("2010"),
	"popup renders the build year",
);
check(richPopup.includes("Rynek"), "popup renders the market");
check(
	richPopup.includes("Biuro nieruchomości: Biuro X"),
	"popup renders the advertiser and agency",
);
check(richPopup.includes("Zarezerwowane"), "popup renders the portal status");
check(
	richPopup.includes("Czynsz:") && richPopup.includes("Kaucja:"),
	"popup renders the rental costs",
);
check(richPopup.includes("Balkon"), "popup renders amenity badges");
check(!richPopup.includes("undefined"), "popup has no undefined placeholders");

const fallbackPopup = popupHtml({
	...popupBase,
	attributes: undefined,
	features: JSON.stringify({
		build_year: 1998,
		building_material: "cegła",
		city: "Kraków",
		street: "Długa",
		street_number: "5",
		extras_types: ["balkon", "winda"],
	}),
});
check(
	fallbackPopup.includes("Rok budowy") && fallbackPopup.includes("Balkon"),
	"popup falls back to raw features for old rows",
);

const floorPopup = popupHtml({ ...popupBase, floor: "floor_0" });
check(
	floorPopup.includes("parter") && !floorPopup.includes("floor_0"),
	"popup humanizes the portal floor code",
);

const onRequestPopup = popupHtml({
	...popupBase,
	price: null,
	attributes: { priceOnRequest: true },
});
check(
	onRequestPopup.includes("Cena na zapytanie"),
	"popup labels a price-on-request offer",
);

const escapedPopup = popupHtml({
	...popupBase,
	title: '<img src=x onerror="alert(1)">',
	attributes: { agencyName: "<script>alert(1)</script>" },
});
check(
	!escapedPopup.includes("<img") &&
		!escapedPopup.includes("<script>") &&
		escapedPopup.includes("&lt;img"),
	"popup escapes portal text",
);

console.log(
	failures === 0
		? "\nAll listing-view checks passed."
		: `\n${failures} listing-view check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
