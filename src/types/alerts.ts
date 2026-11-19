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
	/**
	 * House extras, stored with the same blob. Only a house score carries them:
	 * the nearest other OSM footprint, how many stand within 150 m, and the
	 * nightly-price median of the short-term rentals within 2 km.
	 */
	neighbourM?: number | null;
	neighbours150m?: number | null;
	strNightly?: number | null;
	strSample?: number | null;
	source?: string | null;
}

/** The physical facts of an offer that the alert card surfaces. */
export interface AlertProperties {
	buildYear: number | null;
	heatingType: string | null;
	/** Human label resolved from the column, the portal blob or the prose. */
	heatingLabel: string | null;
	/**
	 * The building as a buyer reads it: kamienica, stary blok, nowy blok,
	 * apartamentowiec, blok of unknown age. Null for plots.
	 */
	buildingClass: string | null;
	buildingClassKind: string | null;
	/** What decided the class: "z opisu", "rok budowy 1998", ... */
	buildingClassEvidence: string | null;
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
	/**
	 * House solitude evidence: distance to the nearest other building and the
	 * count within 150 m. Read from the OSM footprint index; null for flats and
	 * plots, and for houses scored before the extras were stored.
	 */
	neighbourM: number | null;
	neighbours150m: number | null;
	/** Median nightly price of nearby short-term rentals, PLN, and its sample. */
	strNightly: number | null;
	strSample: number | null;
}

/**
 * One comparable behind the fair-value median, as stored with the score
 * (`listing_scores.valuation_json.comparables`). `priceM2` is the comp's own
 * price per m² at the time of the deal; `adjustedPriceM2` is that price
 * brought to today, so they differ when an index or asking-ratio correction
 * applied.
 */
export interface AlertComparable {
	/** `rcn:<transactionId>` or `listing:<source>:<externalId>`. */
	id: string;
	source: "rcn" | "listing";
	/** Deal or posting date, ISO 8601; null when the source carried none. */
	date: string | null;
	distanceM: number | null;
	areaM2: number | null;
	rooms: number | null;
	/** RCN street and housenumber when the registry had one. */
	address: string | null;
	/** Transaction price (or asking price for a listing comp), zł/m². */
	priceM2: number;
	/** Price after the time and asking-to-transaction corrections, zł/m². */
	adjustedPriceM2: number;
	/** Time index or asking-ratio factor applied to `priceM2`. */
	timeFactor: number;
	askingRatio: number | null;
}

/** Evidence behind the stored fair value. */
export interface AlertValuation {
	/** Condition/quality correction applied to the comp median, percent. */
	qualityPct: number;
	/** False when no facts were available (correction is then neutral). */
	qualityKnown: boolean;
	qualityReasons: Array<{ code: string; label: string; pct: number }>;
	/**
	 * The comparables the median was built from, strongest first. Empty for a
	 * score row written before the field existed, in which case the card keeps
	 * the static "Wycena z N ofert" note instead of a disclosure.
	 */
	comparables: AlertComparable[];
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
