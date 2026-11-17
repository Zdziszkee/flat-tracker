/**
 * Client/server contract for RCN transaction history.
 *
 * The SQL shape lives in `src/db/queries/transaction-history.ts`; the map
 * popups (`/api/buildings/lookup`, `/api/parcels/lookup`) and their `fetch()`
 * call sites read the same declarations from here, so a column rename cannot
 * leave one side believing in a field the other never sends.
 */

/** One RCN sale row as rendered in the building/parcel popups. */
export interface TransactionHistoryRow {
	date: string;
	price: number;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	street: string | null;
	streetNumber: string | null;
	district: string | null;
}

/** One row of the year-by-year price breakdown. */
export interface TransactionHistoryYear {
	year: string;
	count: number;
	avgPricePerM2: number | null;
}

/**
 * The aggregate/byYear/recent block shared by the building and parcel
 * lookups. Keep the query shape in one place so a date-format or ordering
 * change cannot make the two popups disagree.
 */
export interface TransactionHistory {
	txCount: number;
	avgPricePerM2: number | null;
	minPricePerM2: number | null;
	maxPricePerM2: number | null;
	minPrice: number | null;
	maxPrice: number | null;
	minDate: string | null;
	maxDate: string | null;
	byYear: TransactionHistoryYear[];
	recent: TransactionHistoryRow[];
}

/** One grouped row per building for `/api/listings`. */
export interface BuildingTransactionSummary {
	buildingId: number | null;
	address: string | null;
	txCount: number;
	txAvgPricePerM2: number | null;
	txMinDate: string | null;
	txMaxDate: string | null;
}

/** What `/api/parcels/lookup` sends for the parcel's own transactions. */
export type ParcelStats = TransactionHistory;

/** Response of `/api/buildings/lookup` (3D building click). */
export interface BuildingLookup {
	building: {
		id: number | null;
		osmId: number;
		address: string | null;
		lat: number;
		lng: number;
		buildYear?: number | null;
		stats: TransactionHistory | null;
	} | null;
}

/** Nearby land-price comparison attached to a parcel lookup. */
export interface ParcelAreaStats {
	/** Quoted per m² (`m2`) or per ar (`ar`, 100 m², GUGiK działki). */
	unit: "m2" | "ar" | string;
	medianM2: number | null;
	txCount: number;
	txCount24m: number;
	byYear: Array<{ year: string; medianM2: number; tx: number }>;
	lastVsMedianPct: number | null;
	basedOn: Array<{
		date: string;
		price: number;
		perUnit: number;
		parcelId: string;
	}>;
}

/** EGiB land metadata for the parcel itself. */
export interface ParcelMeta {
	landUse: string | null;
	zoning: string | null;
	areaHa: number | null;
}

/** Response of `/api/parcels/lookup` (cadastral parcel click). */
export interface ParcelLookup {
	parcel: {
		id: string;
		areaKnown?: boolean;
		stats: ParcelStats;
		area: ParcelAreaStats | null;
		meta: ParcelMeta | null;
		features: Record<string, unknown> | null;
	} | null;
}
