/** Shared shapes for the daily in-app alert list. */

import type { AlertSegment } from "#/lib/scoring/config";

/**
 * Proximity evidence stored with a score (`listing_scores.amenities_json`).
 *
 * Distances are metres. The `*Name` fields are optional because rows scored
 * before named proximity evidence existed carry distances only; a name is
 * never invented, so the UI shows an entry only when both parts are present.
 */
export interface AlertAmenities {
	parkM?: number | null;
	parkName?: string | null;
	forestM?: number | null;
	forestName?: string | null;
	waterM?: number | null;
	waterName?: string | null;
	riverM?: number | null;
	riverName?: string | null;
	trainStationM?: number | null;
	stationName?: string | null;
	transitM?: number | null;
	transitName?: string | null;
	tramM?: number | null;
	tramName?: string | null;
	busM?: number | null;
	busName?: string | null;
	railM?: number | null;
	lakeM?: number | null;
	city?: string | null;
	centerM?: number | null;
	source?: string | null;
}

/** The physical facts of an offer that the alert card surfaces. */
export interface AlertProperties {
	buildYear: number | null;
	heatingType: string | null;
	/** Human label resolved from the column, the portal blob or the prose. */
	heatingLabel: string | null;
	buildingType: string | null;
	buildingMaterial: string | null;
	condition: string | null;
	ownership: string | null;
	floorCount: number | null;
	plotAreaM2: number | null;
	market: string | null;
	hasElevator: boolean;
	hasParking: boolean;
	hasGarage: boolean;
	hasBasement: boolean;
	hasBalcony: boolean;
	hasTerrace: boolean;
	hasGarden: boolean;
}

export interface AlertReason {
	label: string;
	impact: number;
	direction: "positive" | "negative";
}

export interface AlertDto {
	id: number;
	alertDate: string;
	/** Wall-clock moment the alert row was appended, ISO 8601. */
	alertCreatedAt: string;
	rank: number;
	score: number;
	segment: AlertSegment;
	region: string;
	discountPct: number | null;
	fairPrice: number | null;
	fairM2: number | null;
	askingPrice: number | null;
	confidence: number;
	valueScore: number;
	transitScore: number;
	greenScore: number;
	propertyScore: number;
	riskScore: number;
	reasons: AlertReason[];
	flags: string[];
	amenities: AlertAmenities | null;
	/** Physical facts of the offer, all optional and never guessed. */
	properties: AlertProperties;
	/** Comparables behind the valuation median (0 when unsampled). */
	compCount: number;
	/** RCN transactions among those comparables. */
	compRcnCount: number;
	/** Portal posting date of the offer, ISO 8601. */
	listedAt: string | null;
	/** When the crawler first stored the offer, ISO 8601. */
	firstSeenAt: string | null;
	/** True when the alert row is younger than 24 hours. */
	isFresh: boolean;
	/** Why the alert was raised (for example "fresh_arrival"); null when the
	 * stored payload does not say. */
	reason: string | null;
	listing: {
		id: number;
		source: string;
		title: string;
		url: string;
		price: number | null;
		pricePerM2: number | null;
		areaM2: number | null;
		rooms: number | null;
		floor: string | null;
		district: string | null;
		city: string | null;
		address: string | null;
		lat: number | null;
		lng: number | null;
		propertyKind: string | null;
		offerType: string;
		firstSeenAt: string | null;
	};
}

export interface AlertsResponse {
	date: string;
	/** Server time the response was assembled, ISO 8601. */
	generatedAt: string;
	/** Number of rows whose alert was created within the last 24 hours. */
	freshCount: number;
	alerts: AlertDto[];
	counts: {
		total: number;
		byRegion: Record<string, number>;
		bySegment: Record<string, number>;
	};
}
