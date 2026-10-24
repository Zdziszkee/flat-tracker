import { z } from "zod";

import type { PropertyKind } from "./property-kind";

export interface ThreadPost {
	author?: string | null;
	at?: string | null;
	text?: string;
}

export interface BudujesieFeatures {
	replies?: number;
	views?: number;
	lastPostAt?: string;
	posts: ThreadPost[];
}

export interface InvestmapFeatures {
	investmentId: string | null;
}

export interface AirbnbFeatures {
	amenities: string[];
}

export interface ParsedListingFeatures {
	raw: Record<string, unknown>;
	budujesie: BudujesieFeatures | null;
	investmap: InvestmapFeatures | null;
	airbnb: AirbnbFeatures | null;
}

const threadPostSchema = z.object({
	author: z.string().nullish(),
	at: z.string().nullish(),
	text: z.string().optional(),
});

const budujesieSchema = z.object({
	replies: z.number().optional(),
	views: z.number().optional(),
	lastPostAt: z.string().optional(),
	posts: z.array(threadPostSchema).optional(),
});

const investmapSchema = z.object({
	investment_id: z.union([z.string(), z.number()]).optional(),
});

const airbnbSchema = z.object({
	amenities: z.array(z.unknown()).optional(),
});

const EMPTY: ParsedListingFeatures = {
	raw: {},
	budujesie: null,
	investmap: null,
	airbnb: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the `listings.features` JSON once, at the boundary. Portal adapters
 * write different shapes into the same column; typed accessors prevent the
 * `JSON.parse(...) as SomeShape` casts that previously drifted between the
 * map and the listings table.
 */
export function parseListingFeatures(
	raw: string | null | undefined,
): ParsedListingFeatures {
	if (!raw) return EMPTY;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return EMPTY;
	}
	if (!isRecord(json)) return EMPTY;

	const budujesie = budujesieSchema.safeParse(json);
	const investmap = investmapSchema.safeParse(json);
	const airbnb = airbnbSchema.safeParse(json);

	return {
		raw: json,
		budujesie: budujesie.success
			? {
					replies: budujesie.data.replies,
					views: budujesie.data.views,
					lastPostAt: budujesie.data.lastPostAt,
					posts: budujesie.data.posts ?? [],
				}
			: null,
		investmap: investmap.success
			? {
					investmentId: investmap.data.investment_id?.toString() ?? null,
				}
			: null,
		airbnb: airbnb.success
			? {
					amenities: (airbnb.data.amenities ?? []).filter(
						(value): value is string => typeof value === "string",
					),
				}
			: null,
	};
}

/** Keep only the fields a listing filter needs. */
export interface FilterableListing {
	source: string;
	externalId: string;
	listedAt: string | null;
	firstSeenAt: string | null;
	offerType?: string;
	propertyKind?: PropertyKind | null;
}

export type DaysFilter = 0 | 1 | 7 | 30;
export type OfferTypeFilter = "all" | "sale" | "rental";
/**
 * "Inwestycje publiczne" is a category of its own, not a listing kind: it
 * selects the city-project layer instead of offers. Keeping it in the same
 * filter means the map and table show it next to flats, houses and plots.
 */
export const PUBLIC_INVESTMENTS_KIND = "public-investments";

export type KindFilter = "all" | PropertyKind | typeof PUBLIC_INVESTMENTS_KIND;

export interface ListingFilters {
	source: string;
	days: DaysFilter;
	kind: KindFilter;
	offerType: OfferTypeFilter;
}

export const DEFAULT_LISTING_FILTERS: ListingFilters = {
	source: "all",
	days: 0,
	kind: "all",
	offerType: "all",
};

export const DAY_OPTIONS: ReadonlyArray<{
	value: DaysFilter;
	label: string;
}> = [
	{ value: 0, label: "Wszystkie" },
	{ value: 30, label: "Ostatnie 30 dni" },
	{ value: 7, label: "Ostatnie 7 dni" },
	{ value: 1, label: "Ostatnie 24 h" },
];

/**
 * Freshness is always the date the row was added to the market: the portal's
 * own posting date when it exposes one (`listedAt`), otherwise the first time
 * this tracker saw the row (`firstSeenAt`). Every source obeys the same rule —
 * a budujesie thread or an investmap investment row is not exempt. A row with
 * neither date cannot be placed in a window.
 */
export function matchesTimeWindow(
	row: Pick<FilterableListing, "listedAt" | "firstSeenAt">,
	days: DaysFilter,
): boolean {
	if (days === 0) return true;
	const added = row.listedAt ?? row.firstSeenAt;
	if (!added) return false;
	return Date.now() - new Date(added).getTime() <= days * 86_400_000;
}

export function matchesListingFilters(
	row: FilterableListing,
	filters: ListingFilters,
): boolean {
	// A public-investment category is not a listing kind: it swaps the whole
	// dataset, so no offer can match it.
	if (filters.kind === PUBLIC_INVESTMENTS_KIND) return false;
	return (
		(filters.source === "all" || row.source === filters.source) &&
		(filters.kind === "all" || row.propertyKind === filters.kind) &&
		matchesTimeWindow(row, filters.days) &&
		(filters.offerType === "all" ||
			(filters.offerType === "rental"
				? row.offerType !== "sale"
				: row.offerType === "sale"))
	);
}

export function filterListings<T extends FilterableListing>(
	rows: readonly T[],
	filters: ListingFilters,
): T[] {
	return rows.filter((row) => matchesListingFilters(row, filters));
}

export interface ListingFacets {
	total: number;
	bySource: Map<string, number>;
	byKind: Map<PropertyKind, number>;
}

/**
 * Counts respect the time window only, not the currently selected source or
 * kind: every option must show how many offers selecting it would reveal.
 */
export function listingFacets(
	rows: readonly FilterableListing[],
	days: DaysFilter,
): ListingFacets {
	const bySource = new Map<string, number>();
	const byKind = new Map<PropertyKind, number>();
	let total = 0;
	for (const row of rows) {
		if (!matchesTimeWindow(row, days)) continue;
		total++;
		bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1);
		if (row.propertyKind) {
			byKind.set(row.propertyKind, (byKind.get(row.propertyKind) ?? 0) + 1);
		}
	}
	return { total, bySource, byKind };
}

const daysSchema = z.coerce
	.number()
	.pipe(z.union([z.literal(0), z.literal(1), z.literal(7), z.literal(30)]))
	.catch(0)
	.optional();

const kindSchema = z
	.union([
		z.literal("all"),
		z.literal("apartment"),
		z.literal("house"),
		z.literal("plot"),
		z.literal(PUBLIC_INVESTMENTS_KIND),
	])
	.catch("all")
	.optional();

const offerTypeSchema = z
	.union([z.literal("all"), z.literal("sale"), z.literal("rental")])
	.catch("all")
	.optional();

/** URL search schema shared by `/map` and `/listings`. */
export const listingSearchSchema = z.object({
	source: z.string().optional(),
	days: daysSchema,
	kind: kindSchema,
	offerType: offerTypeSchema,
	page: z.coerce.number().int().min(0).catch(0).optional(),
});

export type ListingSearch = z.infer<typeof listingSearchSchema>;

export const DEFAULT_LISTING_SEARCH: ListingSearch = {};

export function filtersFromSearch(search: ListingSearch): ListingFilters {
	return {
		source: search.source ?? "all",
		days: search.days ?? 0,
		kind: search.kind ?? "all",
		offerType: search.offerType ?? "all",
	};
}

export function searchFromFilters(filters: ListingFilters): ListingSearch {
	const search: ListingSearch = {};
	if (filters.source !== "all") search.source = filters.source;
	if (filters.days !== 0) search.days = filters.days;
	if (filters.kind !== "all") search.kind = filters.kind;
	if (filters.offerType !== "all") search.offerType = filters.offerType;
	return search;
}
