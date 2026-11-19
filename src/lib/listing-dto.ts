import type { ListingAttributesDto } from "#/types/listing";
import { buildingClassOf } from "./building-class";
import { parseListingFeatures } from "./listing-features";
import { HEATING_LABELS, resolveHeatingEvidence } from "./scoring/heating";

/**
 * Row-shape helpers shared by the listings API views. They deliberately do
 * not touch the DB: the route feeds them plain rows from Drizzle/better-sqlite3
 * and they return the compact DTOs the client consumes.
 */

export function iso(value: Date | string | number | null): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * `features` is a full scraper payload, but the popup only reads the Airbnb
 * amenities preview and the Budujesie forum posts. Investmap features are only
 * needed server-side (investment-id dedupe), so dropping them here removes
 * several MB from the feed without changing a popup.
 */
export function clientFeatures(row: {
	source: string;
	features: string | null;
}): string | null {
	if (row.source === "investmap") return null;
	if (row.source === "airbnb") {
		const parsed = parseListingFeatures(row.features);
		return parsed.airbnb
			? JSON.stringify({ amenities: parsed.airbnb.amenities })
			: null;
	}
	return row.features;
}

/**
 * Columns promoted from `features` for the popup. The map feed no longer
 * ships them per row; the detail view assembles this compact object once.
 */
export const ATTRIBUTE_KEYS = [
	"city",
	"postalCode",
	"street",
	"streetNumber",
	"plotAreaM2",
	"plotType",
	"buildingType",
	"market",
	"buildYear",
	"buildingMaterial",
	"floorCount",
	"condition",
	"ownership",
	"hasBalcony",
	"hasTerrace",
	"hasGarden",
	"hasElevator",
	"hasParking",
	"hasGarage",
	"hasBasement",
	"isFurnished",
	"petsAllowed",
	"adminFee",
	"deposit",
	"priceNegotiable",
	"priceOnRequest",
	"advertiserType",
	"agencyName",
	"portalStatus",
	"sourceUpdatedAt",
	"investmentTitle",
	"developer",
	"auctionType",
	"auctionDate",
	"wadium",
	"seller",
] as const;

export function popupAttributes(row: object): ListingAttributesDto {
	const out: ListingAttributesDto = {};
	const values = row as Record<string, unknown>;
	for (const key of ATTRIBUTE_KEYS) {
		const value = values[key];
		if (value == null || value === false || value === 0) continue;
		Object.assign(out, {
			[key]: value instanceof Date ? value.toISOString() : value,
		});
	}

	// The two facts every offer card must state, derived once here so the map
	// popup and the table panel never disagree with the alert cards.
	const propertyKind =
		typeof values.propertyKind === "string" ? values.propertyKind : null;
	if (propertyKind !== "plot") {
		const building = buildingClassOf({
			buildingType:
				typeof values.buildingType === "string" ? values.buildingType : null,
			buildingMaterial:
				typeof values.buildingMaterial === "string"
					? values.buildingMaterial
					: null,
			buildYear: typeof values.buildYear === "number" ? values.buildYear : null,
			propertyKind: propertyKind === "house" ? "house" : "apartment",
		});
		out.buildingClass = building.label;
		out.buildingClassKind = building.kind;
	}
	const featuresHeating = featureHeating(values.features);
	const heating = resolveHeatingEvidence({
		heatingType:
			typeof values.heatingType === "string" ? values.heatingType : null,
		featuresHeating,
	});
	if (propertyKind !== "plot") {
		out.heatingLabel =
			heating.kind === "unknown"
				? "nie potwierdzone"
				: HEATING_LABELS[heating.kind];
	}
	return out;
}

/** `features.heating` from the raw scraper blob, when it is valid JSON. */
function featureHeating(features: unknown): string | null {
	if (typeof features !== "string") return null;
	try {
		const parsed = JSON.parse(features) as { heating?: unknown };
		return typeof parsed.heating === "string" ? parsed.heating : null;
	} catch {
		return null;
	}
}
