import type { PropertyKind } from "#/lib/property-kind";

/**
 * What each listing column is, and which kinds of offer it can describe.
 *
 * The `listings` table is one wide row because every screen reads it the same
 * way, but the fields are not universal: a plot has no heating, a flat has no
 * plot type, a sale has no minimum-stay nights. This map is the single place
 * that says so. The record panel reads it to show a flat/house/plot form
 * instead of 82 mostly-null columns, the SQL views (`listing_flats`,
 * `listing_houses`, `listing_plots`) are generated from it, and a validator
 * checks that every database column is covered so a new column cannot silently
 * fall out of the schema.
 *
 * With values: a field that does not apply to the row but carries a value is
 * still shown (under "poza schematem"), because a portal that mixes a flat's
 * attributes into a plot row is evidence, not noise to hide.
 */

export type ListingOfferType =
	| "sale"
	| "long_term_rental"
	| "short_term_rental";

export const LISTING_OFFER_TYPES: ListingOfferType[] = [
	"sale",
	"long_term_rental",
	"short_term_rental",
];

export const KIND_LABEL: Record<PropertyKind, string> = {
	apartment: "mieszkanie",
	house: "dom",
	plot: "działka",
};

export const OFFER_LABEL: Record<ListingOfferType, string> = {
	sale: "sprzedaż",
	long_term_rental: "wynajem",
	short_term_rental: "wynajem krótkoterminowy",
};

/**
 * Offer-type badge colours. Sale is the neutral default, a long-term rental
 * reads as a different market and a short-term rental as a different asset,
 * so the three never look alike in the table.
 */
export const OFFER_TONE: Record<ListingOfferType, string> = {
	sale: "border-border/60 text-muted-foreground",
	long_term_rental: "border-sky-500/40 text-sky-300",
	short_term_rental: "border-amber-500/40 text-amber-300",
};

/** Section order in the panel. */
export const FIELD_GROUPS = [
	"Ogłoszenie",
	"Cena i powierzchnia",
	"Lokalizacja",
	"Budynek",
	"Działka",
	"Media i koszty",
	"Najem krótkoterminowy",
	"Aukcja",
	"Inwestycja",
	"Techniczne",
] as const;

export type FieldGroup = (typeof FIELD_GROUPS)[number];

export interface ListingFieldSpec {
	/** Column key exactly as `/api/listings?view=record` returns it. */
	key: string;
	label: string;
	group: FieldGroup;
	/** Kinds the field describes; omitted = every kind. */
	kinds?: PropertyKind[];
	/** Offer types the field describes; omitted = every offer. */
	offers?: ListingOfferType[];
}

const APARTMENT_OR_HOUSE: PropertyKind[] = ["apartment", "house"];
const HOUSE_OR_PLOT: PropertyKind[] = ["house", "plot"];
const RENTAL: ListingOfferType[] = ["long_term_rental", "short_term_rental"];
const LONG_TERM: ListingOfferType[] = ["long_term_rental"];
const SHORT_TERM: ListingOfferType[] = ["short_term_rental"];

/**
 * Every column of `listings`, in the table's own order, with the kinds it
 * applies to. `validate:listing-schema` fails when a column is missing or
 * unknown, so adding a column means adding it here.
 */
export const LISTING_FIELDS: ListingFieldSpec[] = [
	{ key: "id", label: "identyfikator", group: "Ogłoszenie" },
	{ key: "source", label: "źródło", group: "Ogłoszenie" },
	{ key: "externalId", label: "id w portalu", group: "Ogłoszenie" },
	{ key: "url", label: "link", group: "Ogłoszenie" },
	{ key: "title", label: "tytuł", group: "Ogłoszenie" },
	{ key: "price", label: "cena", group: "Cena i powierzchnia" },
	{ key: "pricePerM2", label: "cena za m²", group: "Cena i powierzchnia" },
	{
		key: "areaM2",
		label: "powierzchnia",
		group: "Cena i powierzchnia",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "rooms",
		label: "pokoje",
		group: "Cena i powierzchnia",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "floor",
		label: "piętro",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{ key: "district", label: "dzielnica", group: "Lokalizacja" },
	{ key: "address", label: "adres", group: "Lokalizacja" },
	{ key: "description", label: "opis", group: "Ogłoszenie" },
	{ key: "firstSeenAt", label: "pierwsze pobranie", group: "Ogłoszenie" },
	{
		key: "heatingType",
		label: "ogrzewanie",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{ key: "propertyType", label: "typ z portalu", group: "Ogłoszenie" },
	{ key: "features", label: "atrybuty portalu (JSON)", group: "Ogłoszenie" },
	{ key: "market", label: "rynek", group: "Ogłoszenie" },
	{
		key: "buildYear",
		label: "rok budowy",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "buildingMaterial",
		label: "materiał",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "floorCount",
		label: "pięter w budynku",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "condition",
		label: "stan",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "ownership",
		label: "własność",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{ key: "city", label: "miasto", group: "Lokalizacja" },
	{ key: "voivodeship", label: "województwo", group: "Lokalizacja" },
	{ key: "postalCode", label: "kod pocztowy", group: "Lokalizacja" },
	{ key: "street", label: "ulica", group: "Lokalizacja" },
	{ key: "streetNumber", label: "numer", group: "Lokalizacja" },
	{
		key: "plotAreaM2",
		label: "powierzchnia działki",
		group: "Działka",
		kinds: HOUSE_OR_PLOT,
	},
	{
		key: "plotType",
		label: "typ działki",
		group: "Działka",
		kinds: HOUSE_OR_PLOT,
	},
	{
		key: "buildingType",
		label: "rodzaj budynku",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "hasBalcony",
		label: "balkon",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "hasTerrace",
		label: "taras",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "hasGarden",
		label: "ogród",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "hasElevator",
		label: "winda",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "hasParking",
		label: "parking",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "hasGarage",
		label: "garaż",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "hasBasement",
		label: "piwnica",
		group: "Budynek",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "isFurnished",
		label: "umeblowane",
		group: "Media i koszty",
		kinds: APARTMENT_OR_HOUSE,
		offers: RENTAL,
	},
	{
		key: "petsAllowed",
		label: "zwierzęta",
		group: "Media i koszty",
		kinds: APARTMENT_OR_HOUSE,
		offers: RENTAL,
	},
	{
		key: "adminFee",
		label: "czynsz administracyjny",
		group: "Media i koszty",
		offers: LONG_TERM,
	},
	{
		key: "deposit",
		label: "kaucja",
		group: "Media i koszty",
		offers: LONG_TERM,
	},
	{
		key: "priceNegotiable",
		label: "do negocjacji",
		group: "Cena i powierzchnia",
	},
	{
		key: "priceOnRequest",
		label: "cena na zapytanie",
		group: "Cena i powierzchnia",
	},
	{ key: "advertiserType", label: "ogłoszeniodawca", group: "Ogłoszenie" },
	{ key: "agencyName", label: "agencja", group: "Ogłoszenie" },
	{ key: "portalStatus", label: "status w portalu", group: "Ogłoszenie" },
	{
		key: "sourceUpdatedAt",
		label: "aktualizacja w portalu",
		group: "Ogłoszenie",
	},
	{
		key: "investmentId",
		label: "id inwestycji",
		group: "Inwestycja",
		offers: ["sale"],
	},
	{
		key: "investmentTitle",
		label: "inwestycja",
		group: "Inwestycja",
		offers: ["sale"],
	},
	{
		key: "developer",
		label: "deweloper",
		group: "Inwestycja",
		offers: ["sale"],
	},
	{
		key: "auctionType",
		label: "typ aukcji",
		group: "Aukcja",
		offers: ["sale"],
	},
	{
		key: "auctionDate",
		label: "data aukcji",
		group: "Aukcja",
		offers: ["sale"],
	},
	{ key: "wadium", label: "wadium", group: "Aukcja", offers: ["sale"] },
	{
		key: "seller",
		label: "sprzedający (sąd, urząd)",
		group: "Aukcja",
		offers: ["sale"],
	},
	{ key: "lastSeenAt", label: "ostatnie pobranie", group: "Ogłoszenie" },
	{ key: "deactivatedAt", label: "dezaktywacja", group: "Ogłoszenie" },
	{ key: "isActive", label: "aktywne", group: "Techniczne" },
	{ key: "lat", label: "szerokość geo", group: "Lokalizacja" },
	{ key: "lng", label: "długość geo", group: "Lokalizacja" },
	{
		key: "buildingId",
		label: "budynek w bazie",
		group: "Lokalizacja",
		kinds: APARTMENT_OR_HOUSE,
	},
	{
		key: "parcelId",
		label: "działka w bazie",
		group: "Lokalizacja",
		kinds: HOUSE_OR_PLOT,
	},
	{ key: "listedAt", label: "data dodania", group: "Ogłoszenie" },
	{ key: "scrapedAt", label: "pobrano", group: "Techniczne" },
	{ key: "offerType", label: "oferta", group: "Ogłoszenie" },
	{
		key: "pricePeriod",
		label: "okres ceny",
		group: "Cena i powierzchnia",
		offers: RENTAL,
	},
	{
		key: "minimumStayNights",
		label: "min. pobyt (nocy)",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "rating",
		label: "ocena",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "reviewsCount",
		label: "liczba opinii",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "availabilityCount",
		label: "dostępne terminy",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "maxGuests",
		label: "maks. gości",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "bedrooms",
		label: "sypialnie",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "beds",
		label: "łóżka",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "bathrooms",
		label: "łazienki",
		group: "Najem krótkoterminowy",
		offers: SHORT_TERM,
	},
	{
		key: "utilities",
		label: "media działki (JSON)",
		group: "Działka",
		kinds: HOUSE_OR_PLOT,
	},
	{
		key: "constructionEndLabel",
		label: "realizacja",
		group: "Inwestycja",
		offers: ["sale"],
	},
	{
		key: "constructionEndDate",
		label: "data realizacji",
		group: "Inwestycja",
		offers: ["sale"],
	},
	{ key: "propertyKind", label: "rodzaj (pochodna)", group: "Ogłoszenie" },
	{ key: "isVisible", label: "widoczne", group: "Techniczne" },
	{ key: "mapLat", label: "szerokość na mapie", group: "Lokalizacja" },
	{ key: "mapLng", label: "długość na mapie", group: "Lokalizacja" },
	{ key: "derivedAt", label: "przeliczono", group: "Techniczne" },
];

const BY_KEY = new Map(LISTING_FIELDS.map((field) => [field.key, field]));

export function fieldSpec(key: string): ListingFieldSpec | null {
	return BY_KEY.get(key) ?? null;
}

export function fieldApplies(
	spec: ListingFieldSpec,
	kind: PropertyKind | null,
	offer: ListingOfferType | null,
): boolean {
	if (kind != null && spec.kinds && !spec.kinds.includes(kind)) return false;
	if (offer != null && spec.offers && !spec.offers.includes(offer))
		return false;
	return true;
}

/** The offer type of a row, with the sale default the feeds use. */
export function offerTypeOf(
	value: string | null | undefined,
): ListingOfferType {
	if (value === "long_term_rental" || value === "short_term_rental") {
		return value;
	}
	return "sale";
}

export interface SchemaField {
	key: string;
	label: string;
	value: unknown;
}

export interface SchemaGroup {
	title: FieldGroup;
	fields: SchemaField[];
}

export interface ListingRecordSchema {
	kind: PropertyKind | null;
	offer: ListingOfferType;
	title: string;
	groups: SchemaGroup[];
	/** Fields outside the kind/offer schema that still carry a value. */
	extra: SchemaField[];
	/** Applicable-schema fields present in the row but absent from the map. */
	unmapped: SchemaField[];
	/** Column keys the schema excludes for this kind/offer (all empty). */
	excluded: string[];
}

/**
 * Lay a stored row out as its kind's form: the applicable fields, grouped and
 * in a fixed order, then any out-of-schema field that actually carries data
 * (so a mixed-up portal payload stays visible), then the excluded columns.
 */
export function buildListingRecord(
	row: Record<string, unknown>,
	kind: PropertyKind | null,
	offer: ListingOfferType,
): ListingRecordSchema {
	const groups = new Map<FieldGroup, SchemaField[]>();
	const extra: SchemaField[] = [];
	const unmapped: SchemaField[] = [];
	const excluded: string[] = [];
	const seen = new Set<string>();

	const add = (group: FieldGroup, field: SchemaField) => {
		const list = groups.get(group) ?? [];
		list.push(field);
		groups.set(group, list);
	};

	for (const spec of LISTING_FIELDS) {
		seen.add(spec.key);
		const value = row[spec.key];
		if (fieldApplies(spec, kind, offer)) {
			add(spec.group, { key: spec.key, label: spec.label, value });
		} else if (value != null && value !== "") {
			extra.push({ key: spec.key, label: spec.label, value });
		} else {
			excluded.push(spec.key);
		}
	}

	// A column the map does not know yet (a new schema field before this file
	// caught up) is shown rather than dropped.
	for (const [key, value] of Object.entries(row)) {
		if (seen.has(key)) continue;
		unmapped.push({ key, label: key, value });
	}

	return {
		kind,
		offer,
		title:
			kind == null
				? OFFER_LABEL[offer]
				: `${KIND_LABEL[kind]} · ${OFFER_LABEL[offer]}`,
		groups: FIELD_GROUPS.filter((group) => groups.has(group)).map((group) => ({
			title: group,
			fields: groups.get(group) ?? [],
		})),
		extra,
		unmapped,
		excluded,
	};
}

/**
 * The three SQL views (`listing_flats`, `listing_houses`, `listing_plots`)
 * project the schema of each kind: the columns a flat/house/plot form needs,
 * with shared identity/location/pricing columns included. Rendered by
 * `bun run build:listing-views`, which writes the migration.
 */
export function viewColumns(kind: PropertyKind): string[] {
	return LISTING_FIELDS.filter((field) => fieldApplies(field, kind, null)).map(
		(field) => field.key,
	);
}
