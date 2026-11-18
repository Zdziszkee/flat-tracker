import type { PropertyKind } from "#/lib/property-kind";
import type { PriceMetric } from "#/lib/valuation/comp-selection";
import type { ValuationStatistics } from "#/lib/valuation/estimate-statistics";
import type { QualityReason } from "#/lib/valuation/quality-factor";
import type { UpsidePotential } from "#/lib/valuation/upside";
import type { OfferForecastDto } from "#/types/forecast";

/** Per-building RCN summary attached to a listing by `/api/listings`. */
export interface TransactionStats {
	buildingId: number;
	address: string | null;
	txCount: number;
	txAvgPricePerM2: number | null;
	txMinDate: string | number | null;
	txMaxDate: string | number | null;
}

/**
 * Normalized portal attributes shipped with the map feed for the popup.
 * Only non-null values are sent; adapters keep the raw blob in `features`.
 */
export interface ListingAttributesDto {
	city?: string | null;
	voivodeship?: string | null;
	postalCode?: string | null;
	street?: string | null;
	streetNumber?: string | null;
	plotAreaM2?: number | null;
	plotType?: string | null;
	buildingType?: string | null;
	hasBalcony?: boolean | null;
	hasTerrace?: boolean | null;
	hasGarden?: boolean | null;
	hasElevator?: boolean | null;
	hasParking?: boolean | null;
	hasGarage?: boolean | null;
	hasBasement?: boolean | null;
	isFurnished?: boolean | null;
	petsAllowed?: boolean | null;
	adminFee?: number | null;
	deposit?: number | null;
	priceNegotiable?: boolean | null;
	priceOnRequest?: boolean | null;
	advertiserType?: string | null;
	agencyName?: string | null;
	portalStatus?: string | null;
	sourceUpdatedAt?: string | null;
	investmentId?: string | null;
	investmentTitle?: string | null;
	developer?: string | null;
	auctionType?: string | null;
	auctionDate?: string | null;
	wadium?: number | null;
	seller?: string | null;
	market?: string | null;
	buildYear?: number | null;
	buildingMaterial?: string | null;
	floorCount?: number | null;
	condition?: string | null;
	ownership?: string | null;
}

/**
 * The row `/api/listings` returns. Keep this as the single client/server
 * contract: the map, the listings table, and the popup all read it.
 */
export interface ListingDto {
	id: number;
	source: string;
	externalId: string;
	url: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
	district: string | null;
	address: string | null;
	city?: string | null;
	plotAreaM2?: number | null;
	buildingType?: string | null;
	adminFee?: number | null;
	deposit?: number | null;
	advertiserType?: string | null;
	auctionType?: string | null;
	auctionDate?: string | null;
	lat: number | null;
	lng: number | null;
	listedAt: string | null;
	firstSeenAt: string | null;
	heatingType: string | null;
	propertyType: string | null;
	/** Derived server-side by `propertyKindOf`; null means "no evidence". */
	propertyKind?: PropertyKind | null;
	attributes?: ListingAttributesDto | null;
	features: string | null;
	constructionEndLabel?: string | null;
	constructionEndDate?: string | null;
	buildingId: number | null;
	buildingAddress: string | null;
	buildingLat?: number | null;
	buildingLng?: number | null;
	/** Cadastral parcel containing the building, assigned by parcel-index.ts. */
	parcelId?: string | null;
	/** Compact parcel feature block for the detail popup. */
	parcelFeatures?: {
		areaM2: number | null;
		perimeterM: number | null;
		frontageM: number | null;
		roadDistanceM: number | null;
		roadClass: string | null;
		buildingCount: number | null;
		buildingCoverage: number | null;
		buildingSubtype: string | null;
		landUseClass: string | null;
		zoningWz: boolean | null;
		zoningNoPlan: boolean | null;
		zoningPlanCount: number | null;
		floodRisk: boolean | null;
		slopeDeg: number | null;
		elevationM: number | null;
	} | null;
	mapLat: number | null;
	mapLng: number | null;
	offerType?: string;
	pricePeriod?: string | null;
	maxGuests?: number | null;
	bedrooms?: number | null;
	beds?: number | null;
	bathrooms?: number | null;
	rating?: number | null;
	reviewsCount?: number | null;
	availabilityCount?: number | null;
	minimumStayNights?: number | null;
	utilities?: string | null;
	transactionStats: TransactionStats | null;
}

/**
 * One point the map actually draws. The full popup payload (`attributes`,
 * `features`, `transactionStats`) is fetched on demand by `view=detail`;
 * shipping it for all ~45k rows was the original 64 MB feed and the main
 * source of client freezes.
 */
export interface MapListingDto {
	id: number;
	source: string;
	externalId: string;
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
	mapLat: number;
	mapLng: number;
	listedAt: string | null;
	firstSeenAt: string | null;
	offerType: string;
	propertyType: string | null;
	propertyKind: PropertyKind | null;
	buildingId: number | null;
	buildingAddress: string | null;
	constructionEndLabel: string | null;
	constructionEndDate: string | null;
}

/** Aggregated cell at overview zooms. */
export interface MapClusterDto {
	kind: "cluster";
	lng: number;
	lat: number;
	count: number;
	/** Source with the most rows in the cell; drives the cluster color. */
	source: string;
}

export interface MapPointDto extends MapListingDto {
	kind: "listing";
}

export type MapFeedPoint = MapPointDto | MapClusterDto;

export interface MapFeedResponse {
	mode: "clusters" | "points";
	points: MapFeedPoint[];
	/** True when the exact-point query hit its safety cap. */
	capped?: boolean;
	generatedAt: string;
}

export interface ListingFacetsResponse {
	total: number;
	bySource: Record<string, number>;
	byKind: Partial<Record<PropertyKind, number>>;
	generatedAt: string;
}

/** Columns the listings table actually renders. */
export interface ListingTableRow {
	id: number;
	source: string;
	externalId: string;
	url: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
	district: string | null;
	city?: string | null;
	plotAreaM2?: number | null;
	buildingType?: string | null;
	adminFee?: number | null;
	deposit?: number | null;
	advertiserType?: string | null;
	auctionType?: string | null;
	auctionDate?: string | null;
	listedAt: string | null;
	firstSeenAt: string | null;
	heatingType: string | null;
	propertyType: string | null;
	propertyKind?: PropertyKind | null;
	features: string | null;
	constructionEndLabel?: string | null;
	constructionEndDate?: string | null;
	offerType?: string;
}

export interface ListingFacetsDto {
	total: number;
	bySource: Record<string, number>;
	byKind: Record<string, number>;
}

export interface ListingsTableResponse {
	listings: ListingTableRow[];
	total: number;
	page: number;
	pageSize: number;
	facets: ListingFacetsDto;
	generatedAt: string;
}

export interface ValuationComp {
	avgM2: number;
	n: number;
}

export interface RentalValuation {
	n: number;
	netMonthly: number;
	netYearly: number;
	netYieldPct: number | null;
}

export type ValuationSegment = "flat" | "house" | "plot";
export type ValuationConfidenceLevel = "high" | "medium" | "low";

export interface ValuationComparable {
	id: string;
	source: "rcn" | "listing";
	date: string | null;
	distanceM: number | null;
	areaM2: number | null;
	rooms: number | null;
	address: string | null;
	originalPrice: number | null;
	originalPriceM2: number;
	timeFactor: number;
	/** Size correction `(compArea / targetArea) ** beta`; 1 when absent. */
	areaFactor?: number | null;
	adjustedPriceM2: number;
	indexSource: string | null;
	indexGeography: string | null;
	indexFromPeriod: string | null;
	indexToPeriod: string | null;
	/** Asking-to-transaction ratio applied to a listing comp, when used. */
	askingRatio?: number | null;
}

export interface ValuationCompSet {
	n: number;
	medianM2: number;
	p25M2: number;
	p75M2: number;
	weight: number;
}

export interface ValuationEstimate {
	segment: ValuationSegment;
	fairM2: number;
	fairPrice: number;
	lowM2: number;
	highM2: number;
	lowPrice: number;
	highPrice: number;
	overUnderPct: number | null;
	rating: { label: string; tone: string } | null;
	confidence: {
		level: ValuationConfidenceLevel;
		rcnCount: number;
		listingCount: number;
		timeAdjustedCount: number;
		totalCount: number;
		spreadPct: number;
		sameBuildingCount: number;
	};
	comparables: ValuationComparable[];
	compSets: {
		buildingRcn: ValuationCompSet | null;
		nearbyRcn: ValuationCompSet | null;
		listing: ValuationCompSet | null;
	};
	index: {
		source: string;
		segment: string;
		geographyType: string;
		geographyKey: string;
		fromPeriod: string;
		toPeriod: string;
	} | null;
	/** Condition/quality correction applied to the comparable median. */
	qualityAdjustmentPct: number;
	qualityAdjustmentKnown: boolean;
	qualityAdjustmentReasons: QualityReason[];
	/** Price aggregate behind `fairM2`; absent on rows written before it existed. */
	metric?: PriceMetric | null;
	/** Positive area elasticity `(compArea / targetArea) ** beta` applied to comps. */
	areaElasticity?: number | null;
	/**
	 * True when the implied discount is so large that the comp set, not the
	 * offer, is the likely explanation (few comps or a wide interquartile range).
	 */
	implausibleDiscount?: boolean;
	implausibleDiscountReason?: string | null;
	/** Evidence behind the correction factors, for audit and the detail card. */
	statistics: ValuationStatistics;
	/** Forward-looking 12-month expectation; null when fair value is unusable. */
	upside: UpsidePotential | null;
}

export interface RentEstimate {
	fairMonthly: number;
	overUnderPct: number | null;
	n: number;
	basis: string;
	confidence: ValuationConfidenceLevel;
}

/** Shape of `/api/valuation/offer`. */
export interface OfferValuation {
	mode: "sale" | "rent";
	eligible: boolean;
	reason: string | null;
	offer: {
		id: number;
		price: number | null;
		pricePerM2: number | null;
		areaM2: number | null;
		offerType: string;
		kind: PropertyKind | null;
	};
	estimate: ValuationEstimate | null;
	rent: RentEstimate | null;
	/**
	 * Purchase price used as the ROI denominator. Sales use the asking price;
	 * rentals and price-less offers use an estimated market value.
	 */
	buyPrice: {
		price: number;
		source: "asking" | "estimated";
		/** Median RCN zł/m² behind an estimated purchase price. */
		fairM2: number | null;
	} | null;
	/** Probabilistic LTR/STR/appreciation forecast from the market models. */
	forecast: OfferForecastDto;
	lt:
		| (RentalValuation & {
				rentAvg: number;
				czynszAvg: number;
				basis: string;
		  })
		| null;
	str:
		| (RentalValuation & {
				nightlyAvg: number;
				occupancy: number;
				basis: string;
		  })
		| null;
}
