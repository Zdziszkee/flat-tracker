/**
 * Pin the portal-attribute normalizer that promotes the raw `features` blob
 * into listings columns: alias keys, area units, negation-aware amenity
 * flags, costs, advertiser, investment and auction metadata.
 * Run with `bun run validate:listing-attributes`.
 */
import { normalizeListingAttributes } from "../src/crawler/attributes.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

function normalize(value: unknown) {
	return normalizeListingAttributes(JSON.stringify(value));
}

const otodom = normalize({
	// otodom detail attributes plus the adapter's computed keys.
	city: "Kraków",
	voivodeship: "małopolskie",
	postal_code: "31-001",
	street: "Długa",
	street_number: "5",
	plot_area: "2,5 ha",
	plot_type: "budowlana",
	building_type: "blok",
	extras_types: ["balcony", "elevator", "piwnica"],
	terrace: false,
	garden: "tak",
	parking: "brak",
	garage: "nie",
	furniture: "tak",
	pets: "nie",
	totalMaintenanceFee: 706,
	deposit: 3500,
	negotiable: true,
	on_request: false,
	advertiser_type: "agency",
	agency: "Biuro X",
	status: "active",
	modified_at: "2026-10-01T10:00:00Z",
	investment_id: "dev-9",
	investment_title: "Osiedle X",
	developer: "Deweloper Y",
	auction_type: "licytacja",
	auction_date: "2026-11-01",
	wadium: 10_000,
	seller: "AMW",
});

check(otodom.city === "Kraków", "reads the city");
check(otodom.voivodeship === "małopolskie", "reads the voivodeship");
check(otodom.postalCode === "31-001", "reads the postal code");
check(
	otodom.street === "Długa" && otodom.streetNumber === "5",
	"splits street and number",
);
check(otodom.plotAreaM2 === 25_000, "converts hectares to m²");
check(otodom.plotType === "budowlana", "normalizes the plot type");
check(otodom.buildingType === "block", "normalizes the building type");
check(otodom.hasBalcony === true, "amenity array marks a balcony");
check(otodom.hasElevator === true, "amenity array marks a lift");
check(otodom.hasBasement === true, "amenity array marks a basement");
check(otodom.hasTerrace === false, "explicit false stays false");
check(otodom.hasGarden === true, "Polish 'tak' is true");
check(otodom.hasParking === false, "Polish 'brak' is false");
check(otodom.hasGarage === false, "Polish 'nie' is false");
check(otodom.isFurnished === true, "furniture flag is promoted");
check(otodom.petsAllowed === false, "pets flag is promoted");
check(otodom.adminFee === 706, "reads the maintenance fee");
check(otodom.deposit === 3500, "reads the deposit");
check(otodom.priceNegotiable === true, "reads negotiability");
check(otodom.priceOnRequest === false, "reads price-on-request");
check(otodom.advertiserType === "agency", "classifies the advertiser");
check(otodom.agencyName === "Biuro X", "reads the agency name");
check(otodom.portalStatus === "active", "normalizes the portal status");
check(
	otodom.sourceUpdatedAt instanceof Date &&
		otodom.sourceUpdatedAt.toISOString() === "2026-10-01T10:00:00.000Z",
	"parses the portal modification date",
);
check(otodom.investmentId === "dev-9", "reads the investment id");
check(otodom.investmentTitle === "Osiedle X", "reads the investment title");
check(otodom.developer === "Deweloper Y", "reads the developer");
check(otodom.auctionType === "licytacja", "reads the auction type");
check(
	otodom.auctionDate instanceof Date &&
		otodom.auctionDate.toISOString().startsWith("2026-11-01"),
	"parses the auction date",
);
check(otodom.wadium === 10_000, "reads the wadium");
check(otodom.seller === "AMW", "reads the seller");

const negated = normalize({ amenities: ["brak windy", "bez balkonu"] });
check(negated.hasElevator === false, "negated lift is false, not true");
check(negated.hasBalcony === false, "negated balcony is false, not true");

const inflected = normalize({ udogodnienia: ["piwnica"] });
check(inflected.hasBasement === true, "matches inflected 'piwnica'");

const plot = normalize({ lot_size: 1200, lot_type: "rolna" });
check(plot.plotAreaM2 === 1200, "reads a numeric plot area");
check(plot.plotType === "rolna", "keeps a farmland plot type");

// Names and prose must not invent amenities: a street called Ogrodowa or an
// investment called Osiedle Ogrodowe is not a garden.
const prose = normalize({
	street: "Ogrodowa",
	city: "Kraków",
	investment_title: "Osiedle Ogrodowe",
	description: "Mieszkanie z windą i balkonem",
});
check(prose.hasGarden == null, "street/investment names do not set a garden");
check(prose.hasElevator == null, "description text does not set a lift");

check(
	normalizeListingAttributes("not json").city === null,
	"malformed JSON degrades to nulls",
);
check(
	normalizeListingAttributes(null).hasBalcony === null,
	"missing features degrade to nulls",
);

console.log(
	failures === 0
		? "\nAll listing-attribute checks passed."
		: `\n${failures} listing-attribute check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
