import type { PropertyKind } from "#/lib/property-kind";

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
	lat: number | null;
	lng: number | null;
	listedAt: string | null;
	firstSeenAt: string | null;
	heatingType: string | null;
	propertyType: string | null;
	/** Derived server-side by `propertyKindOf`; null means "no evidence". */
	propertyKind?: PropertyKind | null;
	features: string | null;
	constructionEndLabel?: string | null;
	constructionEndDate?: string | null;
	buildingId: number | null;
	buildingAddress: string | null;
	buildingLat?: number | null;
	buildingLng?: number | null;
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

export interface ListingsResponse {
	listings: ListingDto[];
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

/** Shape of `/api/valuation/offer`. */
export interface OfferValuation {
	offer: {
		id: number;
		price: number | null;
		pricePerM2: number | null;
		areaM2: number | null;
		offerType: string;
	};
	comps: {
		building: ValuationComp | null;
		area: ValuationComp | null;
		rcn: ValuationComp | null;
		fairM2: number | null;
	};
	overUnderPct: number | null;
	rating: { label: string; tone: string } | null;
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
