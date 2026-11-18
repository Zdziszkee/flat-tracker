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

/**
 * Why this offer is on the list: the fast-rail access point (plots and
 * houses), the centre-zone anchor (flats) and the valuation corrections.
 * Recomputed from the listing coordinates on every request, so a station or
 * anchor added to the dataset shows up without a re-score.
 */
export interface AlertLocation {
	/** Nearest 200 km/h+ station and distance, null for flats or no match. */
	fastRail: {
		name: string;
		city: string;
		distanceM: number;
		/** True when the station carries the planned KDP service (2035+). */
		kdpPlanned: boolean;
		kdpYear: number | null;
	} | null;
	/** Nearest centre-zone anchor and distance, null for houses and plots. */
	centreZone: { name: string; distanceM: number } | null;
}

/** Facts the extractor read out of the description, shown as a card line. */
export interface AlertFacts {
	/** Named defects and legal encumbrances ("damp", "no_lift", ...). */
	risks: string[];
	/** Setting the ad claims: lake, river, forest, mountains, view. */
	setting: string[];
	/** Plot utilities connected (0-5) and the road access the ad states. */
	plotMedia: number | null;
	plotAccess: string | null;
	/** Monthly rent and fundusz remontowy quoted in the ad, PLN. */
	monthlyRent: number | null;
	funduszRemontowy: number | null;
	legalStatus: string | null;
}

/** Evidence behind the stored fair value. */
export interface AlertValuation {
	/** Condition/quality correction applied to the comp median, percent. */
	qualityPct: number;
	/** False when no facts were available (correction is then neutral). */
	qualityKnown: boolean;
	qualityReasons: Array<{ code: string; label: string; pct: number }>;
	/** Median index factor that brought the comparables to today. */
	timeFactorMedian: number | null;
	/** Index period span of the comp set ("2019Q2" -> "2026Q4"). */
	indexSpan: { from: string; to: string } | null;
	askingRatio: number | null;
	askingRatioSource: "measured" | "fallback" | null;
	compAgeMedianYears: number | null;
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
	/** Fast-rail / centre-zone evidence for this offer. */
	location: AlertLocation;
	/** Description facts behind the score. */
	facts: AlertFacts;
	/** Comparable and correction evidence behind the fair value. */
	valuation: AlertValuation | null;
	/** True when the alert row is younger than 24 hours. */
	isFresh: boolean;
	/**
	 * True when the offer fills a short section: every gate passed except
	 * proof of municipal heating, so the card marks it instead of claiming
	 * heating it cannot show.
	 */
	heatingUnknown: boolean;
	/** False for a fallback offer (see `fallbackReason`). */
	eligible: boolean;
	/**
	 * Why a fallback row is on the list: the extractor found no heating
	 * evidence (`heating`) or no buildability evidence (`evidence`). Null for
	 * a fully eligible offer.
	 */
	fallbackReason: "heating" | "evidence" | null;
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
