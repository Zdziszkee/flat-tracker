/**
 * Pin the shared listing-view behavior that the map and the listings table
 * now both consume: time windows, evergreen construction rows, facets, feature
 * parsing, and formatting. Run with `bun run validate:listing-view`.
 */
import {
	parseListingFeatures,
	filterListings,
	isEvergreenListing,
	listingFacets,
	matchesTimeWindow,
} from "../src/lib/listing-features.ts";
import { formatUtilities, realizationCaption } from "../src/lib/format.ts";

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

check(isEvergreenListing(budujesie), "budujesie is evergreen");
check(isEvergreenListing(investmapStandIn), "investmap inv- is evergreen");
check(!isEvergreenListing(investmapFlat), "investmap flat is not evergreen");
check(matchesTimeWindow(budujesie, 1), "evergreen survives the 24h window");
check(matchesTimeWindow(investmapStandIn, 1), "investmap stand-in survives the 24h window");
check(!matchesTimeWindow(investmapFlat, 1), "old investmap flat is hidden by the 24h window");
check(matchesTimeWindow(recentOlx, 7), "recent offer survives the 7d window");
check(!matchesTimeWindow(oldOtodom, 7), "old offer is hidden by the 7d window");

const all = [
	budujesie,
	investmapStandIn,
	investmapFlat,
	oldOtodom,
	recentOlx,
	recentRent,
];
const facets = listingFacets(all, 1);
check(facets.total === 4, "facets count evergreen + recent rows only");
check(facets.bySource.get("budujesie") === 1, "facets count budujesie");
check(facets.bySource.get("investmap") === 1, "facets exclude old investmap flat");
check(facets.byKind.get("house") === 1, "facets count house");

const saleOnly = filterListings(all, {
	source: "all",
	days: 1,
	kind: "all",
	offerType: "sale",
});
check(saleOnly.length === 3, "offerType sale excludes the rental");
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

console.log(
	failures === 0
		? "\nAll listing-view checks passed."
		: `\n${failures} listing-view check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
