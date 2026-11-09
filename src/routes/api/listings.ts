import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lte,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";

import { REGIONS } from "#/crawler/regions";
import { db } from "#/db/index";
import { ensureListingDerived } from "#/db/listing-derived";
import { transactionSummaryByBuilding } from "#/db/queries/transaction-history";
import { buildings, listings } from "#/db/schema";
import {
	ATTRIBUTE_KEYS,
	clientFeatures,
	iso,
	popupAttributes,
} from "#/lib/listing-dto";
import {
	type DaysFilter,
	filtersFromSearch,
	type ListingFilters,
	listingSearchSchema,
	PUBLIC_INVESTMENTS_KIND,
} from "#/lib/listing-features";
import type { PropertyKind } from "#/lib/property-kind";
import { withCache } from "#/lib/server-cache";
import { gzipJson, jsonResponse } from "#/lib/server-response";
import type {
	ListingDto,
	ListingFacetsResponse,
	ListingsTableResponse,
	MapFeedPoint,
	MapFeedResponse,
	MapListingDto,
} from "#/types/listing";

/**
 * `/api/listings` is view-based:
 *
 * - `view=map` (default): viewport-limited map feed. Below `MAP_EXACT_MIN_ZOOM`
 *   it returns aggregated cells (a few hundred KB region-wide instead of the
 *   old 64 MB); above it returns compact points, and popup details are fetched
 *   separately with `view=detail`.
 * - `view=detail&id=...`: the one full popup row.
 * - `view=facets`: source/kind counts for the filter bar, in SQL.
 * - `view=table`: paginated table rows, filtered and counted in SQL.
 *
 * All views read the derived columns (`isVisible`, `propertyKind`, `mapLat`,
 * `mapLng`) maintained by `recomputeListingDerived`, so no request replays the
 * 47k-row dedupe/classification in JavaScript.
 */

/** Exact points from this zoom; below it the server aggregates into cells. */
const MAP_EXACT_MIN_ZOOM = 13;
/** Safety cap for an exact viewport query. */
const MAP_MAX_POINTS = 8000;
/** Sources that keep their own symbol layer and are never aggregated. */
const SPECIAL_SOURCES = ["licytacje-komornik", "budujesie"] as const;
const MAP_CACHE_TTL_MS = 30_000;
const FACETS_CACHE_TTL_MS = 30_000;

interface Bbox {
	minLng: number;
	minLat: number;
	maxLng: number;
	maxLat: number;
}

const DEFAULT_BBOX: Bbox = {
	minLng: Math.min(...REGIONS.map((region) => region.bbox.minLng)),
	minLat: Math.min(...REGIONS.map((region) => region.bbox.minLat)),
	maxLng: Math.max(...REGIONS.map((region) => region.bbox.maxLng)),
	maxLat: Math.max(...REGIONS.map((region) => region.bbox.maxLat)),
};

function parseBbox(params: URLSearchParams): Bbox | null {
	const values = ["minLng", "minLat", "maxLng", "maxLat"].map((key) =>
		Number(params.get(key)),
	);
	if (!values.every(Number.isFinite)) return null;
	const [minLng, minLat, maxLng, maxLat] = values;
	if (minLng >= maxLng || minLat >= maxLat) return null;
	return { minLng, minLat, maxLng, maxLat };
}

function hasBboxParams(params: URLSearchParams): boolean {
	return ["minLng", "minLat", "maxLng", "maxLat"].some((key) =>
		params.has(key),
	);
}

/** The shared time-window predicate (`listedAt ?? firstSeenAt`). */
function daysFilterSql(days: DaysFilter): SQL | undefined {
	if (days === 0) return undefined;
	const cutoff = Math.floor((Date.now() - days * 86_400_000) / 1000);
	return sql`coalesce(${listings.listedAt}, ${listings.firstSeenAt}) >= ${cutoff}`;
}

/** Source/kind/offer-type/time filters, always scoped to visible rows. */
function listingFilterSql(filters: ListingFilters): SQL {
	if (filters.kind === PUBLIC_INVESTMENTS_KIND) return sql`0`;
	const parts: Array<SQL | undefined> = [eq(listings.isVisible, true)];
	if (filters.source !== "all") {
		parts.push(eq(listings.source, filters.source));
	}
	if (filters.kind !== "all") {
		parts.push(eq(listings.propertyKind, filters.kind));
	}
	if (filters.offerType === "sale") {
		parts.push(eq(listings.offerType, "sale"));
	} else if (filters.offerType === "rental") {
		parts.push(ne(listings.offerType, "sale"));
	}
	parts.push(daysFilterSql(filters.days));
	return and(...parts) ?? sql`1`;
}

function bboxSql(bbox: Bbox): SQL {
	return and(
		isNotNull(listings.mapLat),
		isNotNull(listings.mapLng),
		gte(listings.mapLat, bbox.minLat),
		lte(listings.mapLat, bbox.maxLat),
		gte(listings.mapLng, bbox.minLng),
		lte(listings.mapLng, bbox.maxLng),
	) as SQL;
}

const mapColumns = {
	id: listings.id,
	source: listings.source,
	externalId: listings.externalId,
	title: listings.title,
	url: listings.url,
	price: listings.price,
	pricePerM2: listings.pricePerM2,
	areaM2: listings.areaM2,
	rooms: listings.rooms,
	floor: listings.floor,
	district: listings.district,
	city: listings.city,
	address: listings.address,
	lat: listings.lat,
	lng: listings.lng,
	mapLat: listings.mapLat,
	mapLng: listings.mapLng,
	listedAt: listings.listedAt,
	firstSeenAt: listings.firstSeenAt,
	offerType: listings.offerType,
	propertyType: listings.propertyType,
	propertyKind: listings.propertyKind,
	buildingId: listings.buildingId,
	buildingAddress: buildings.address,
	constructionEndLabel: listings.constructionEndLabel,
	constructionEndDate: listings.constructionEndDate,
};

type MapRow = {
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
	mapLat: number | null;
	mapLng: number | null;
	listedAt: Date | null;
	firstSeenAt: Date | null;
	offerType: string;
	propertyType: string | null;
	propertyKind: string | null;
	buildingId: number | null;
	buildingAddress: string | null;
	constructionEndLabel: string | null;
	constructionEndDate: string | null;
};

function toMapPoint(row: MapRow): MapListingDto & { kind: "listing" } {
	return {
		kind: "listing",
		id: row.id,
		source: row.source,
		externalId: row.externalId,
		title: row.title,
		url: row.url,
		price: row.price,
		pricePerM2: row.pricePerM2,
		areaM2: row.areaM2,
		rooms: row.rooms,
		floor: row.floor,
		district: row.district,
		city: row.city,
		address: row.address,
		lat: row.lat,
		lng: row.lng,
		mapLat: row.mapLat ?? 0,
		mapLng: row.mapLng ?? 0,
		listedAt: iso(row.listedAt),
		firstSeenAt: iso(row.firstSeenAt),
		offerType: row.offerType,
		propertyType: row.propertyType,
		propertyKind: row.propertyKind as PropertyKind | null,
		buildingId: row.buildingId,
		buildingAddress: row.buildingAddress,
		constructionEndLabel: row.constructionEndLabel,
		constructionEndDate: row.constructionEndDate,
	};
}

async function loadExactPoints(
	filters: ListingFilters,
	bbox: Bbox,
): Promise<{
	points: Array<MapListingDto & { kind: "listing" }>;
	capped: boolean;
}> {
	const rows = await db
		.select(mapColumns)
		.from(listings)
		.leftJoin(buildings, eq(listings.buildingId, buildings.id))
		.where(and(listingFilterSql(filters), bboxSql(bbox)))
		.limit(MAP_MAX_POINTS + 1);
	if (rows.length > MAP_MAX_POINTS) {
		return { points: [], capped: true };
	}
	return { points: rows.map(toMapPoint), capped: false };
}

interface ClusterRow {
	cy: number;
	cx: number;
	source: string;
	count: number;
	lat: number;
	lng: number;
}

/**
 * One feature per `(cell, source)` from SQL, merged per cell in JS. Cell size
 * follows the zoom (~64 px at the current scale) so the overview stays around
 * a thousand circles instead of 45k.
 */
async function loadClusters(
	filters: ListingFilters,
	bbox: Bbox,
	zoom: number,
): Promise<MapFeedPoint[]> {
	const cell = Math.max((360 / 2 ** zoom) * (64 / 512), 0.001);
	const rows = await db.all<ClusterRow>(sql`
		select
			cast(map_lat / ${cell} as integer) as cy,
			cast(map_lng / ${cell} as integer) as cx,
			source,
			count(*) as count,
			avg(map_lat) as lat,
			avg(map_lng) as lng
		from listings
		where ${listingFilterSql(filters)}
			and map_lat is not null and map_lng is not null
			and map_lat between ${bbox.minLat} and ${bbox.maxLat}
			and map_lng between ${bbox.minLng} and ${bbox.maxLng}
			and source not in ('licytacje-komornik', 'budujesie')
		group by cy, cx, source
	`);

	const cells = new Map<
		string,
		{
			lat: number;
			lng: number;
			count: number;
			bySource: Record<string, number>;
		}
	>();
	for (const row of rows) {
		const key = `${row.cy}|${row.cx}`;
		const cellEntry = cells.get(key) ?? {
			lat: 0,
			lng: 0,
			count: 0,
			bySource: {},
		};
		cellEntry.lat += Number(row.lat) * Number(row.count);
		cellEntry.lng += Number(row.lng) * Number(row.count);
		cellEntry.count += Number(row.count);
		cellEntry.bySource[row.source] =
			(cellEntry.bySource[row.source] ?? 0) + Number(row.count);
		cells.set(key, cellEntry);
	}

	return [...cells.values()].map((cellEntry) => {
		let source = "";
		let max = -1;
		for (const [name, count] of Object.entries(cellEntry.bySource)) {
			if (count > max) {
				max = count;
				source = name;
			}
		}
		return {
			kind: "cluster",
			lat: Number((cellEntry.lat / cellEntry.count).toFixed(5)),
			lng: Number((cellEntry.lng / cellEntry.count).toFixed(5)),
			count: cellEntry.count,
			source,
		};
	});
}

/** Special-symbol sources are small and never aggregated. */
async function loadSpecialPoints(
	filters: ListingFilters,
	bbox: Bbox,
): Promise<Array<MapListingDto & { kind: "listing" }>> {
	if (filters.source !== "all") {
		if (!(SPECIAL_SOURCES as readonly string[]).includes(filters.source)) {
			return [];
		}
	}
	const rows = await db
		.select(mapColumns)
		.from(listings)
		.leftJoin(buildings, eq(listings.buildingId, buildings.id))
		.where(
			and(
				listingFilterSql(filters),
				bboxSql(bbox),
				inArray(listings.source, [...SPECIAL_SOURCES]),
			),
		)
		.limit(3000);
	return rows.map(toMapPoint);
}

async function listingFacets(days: DaysFilter): Promise<ListingFacetsResponse> {
	const where = and(eq(listings.isVisible, true), daysFilterSql(days));
	const rows = await db
		.select({
			source: listings.source,
			kind: listings.propertyKind,
			count: sql<number>`count(*)`,
		})
		.from(listings)
		.where(where)
		.groupBy(listings.source, listings.propertyKind);
	const bySource: Record<string, number> = {};
	const byKind: Partial<Record<PropertyKind, number>> = {};
	let total = 0;
	for (const row of rows) {
		const count = Number(row.count);
		total += count;
		bySource[row.source] = (bySource[row.source] ?? 0) + count;
		if (
			row.kind === "apartment" ||
			row.kind === "house" ||
			row.kind === "plot"
		) {
			byKind[row.kind] = (byKind[row.kind] ?? 0) + count;
		}
	}
	return { total, bySource, byKind, generatedAt: new Date().toISOString() };
}

async function cachedFacets(days: DaysFilter): Promise<ListingFacetsResponse> {
	return withCache(`listings-facets-v2:${days}`, FACETS_CACHE_TTL_MS, () =>
		listingFacets(days),
	);
}

const detailColumns = {
	id: listings.id,
	source: listings.source,
	externalId: listings.externalId,
	url: listings.url,
	title: listings.title,
	price: listings.price,
	pricePerM2: listings.pricePerM2,
	areaM2: listings.areaM2,
	rooms: listings.rooms,
	floor: listings.floor,
	district: listings.district,
	address: listings.address,
	city: listings.city,
	voivodeship: listings.voivodeship,
	postalCode: listings.postalCode,
	street: listings.street,
	streetNumber: listings.streetNumber,
	plotAreaM2: listings.plotAreaM2,
	plotType: listings.plotType,
	buildingType: listings.buildingType,
	market: listings.market,
	buildYear: listings.buildYear,
	buildingMaterial: listings.buildingMaterial,
	floorCount: listings.floorCount,
	condition: listings.condition,
	ownership: listings.ownership,
	hasBalcony: listings.hasBalcony,
	hasTerrace: listings.hasTerrace,
	hasGarden: listings.hasGarden,
	hasElevator: listings.hasElevator,
	hasParking: listings.hasParking,
	hasGarage: listings.hasGarage,
	hasBasement: listings.hasBasement,
	isFurnished: listings.isFurnished,
	petsAllowed: listings.petsAllowed,
	adminFee: listings.adminFee,
	deposit: listings.deposit,
	priceNegotiable: listings.priceNegotiable,
	priceOnRequest: listings.priceOnRequest,
	advertiserType: listings.advertiserType,
	agencyName: listings.agencyName,
	portalStatus: listings.portalStatus,
	sourceUpdatedAt: listings.sourceUpdatedAt,
	investmentId: listings.investmentId,
	investmentTitle: listings.investmentTitle,
	developer: listings.developer,
	auctionType: listings.auctionType,
	auctionDate: listings.auctionDate,
	wadium: listings.wadium,
	seller: listings.seller,
	lat: listings.lat,
	lng: listings.lng,
	listedAt: listings.listedAt,
	firstSeenAt: listings.firstSeenAt,
	heatingType: listings.heatingType,
	propertyType: listings.propertyType,
	propertyKind: listings.propertyKind,
	mapLat: listings.mapLat,
	mapLng: listings.mapLng,
	features: listings.features,
	buildingId: listings.buildingId,
	buildingAddress: buildings.address,
	buildingLat: buildings.lat,
	buildingLng: buildings.lng,
	offerType: listings.offerType,
	pricePeriod: listings.pricePeriod,
	minimumStayNights: listings.minimumStayNights,
	rating: listings.rating,
	reviewsCount: listings.reviewsCount,
	availabilityCount: listings.availabilityCount,
	maxGuests: listings.maxGuests,
	bedrooms: listings.bedrooms,
	beds: listings.beds,
	bathrooms: listings.bathrooms,
	utilities: listings.utilities,
	constructionEndLabel: listings.constructionEndLabel,
	constructionEndDate: listings.constructionEndDate,
};

async function loadDetail(id: number): Promise<ListingDto | null> {
	const [row] = await db
		.select(detailColumns)
		.from(listings)
		.leftJoin(buildings, eq(listings.buildingId, buildings.id))
		.where(eq(listings.id, id))
		.limit(1);
	if (!row) return null;

	const base = { ...row } as Record<string, unknown>;
	for (const key of ATTRIBUTE_KEYS) delete base[key];
	const summary =
		row.buildingId != null
			? (await transactionSummaryByBuilding([row.buildingId]))[0]
			: undefined;
	const attributes = popupAttributes(row);
	return {
		...base,
		listedAt: iso(row.listedAt),
		firstSeenAt: iso(row.firstSeenAt),
		sourceUpdatedAt: iso(row.sourceUpdatedAt),
		auctionDate: iso(row.auctionDate),
		attributes: Object.keys(attributes).length > 0 ? attributes : null,
		features: clientFeatures(row),
		mapLat: row.mapLat ?? row.lat,
		mapLng: row.mapLng ?? row.lng,
		transactionStats: summary ?? null,
	} as unknown as ListingDto;
}

const tableColumns = {
	id: listings.id,
	source: listings.source,
	externalId: listings.externalId,
	url: listings.url,
	title: listings.title,
	price: listings.price,
	pricePerM2: listings.pricePerM2,
	areaM2: listings.areaM2,
	rooms: listings.rooms,
	floor: listings.floor,
	district: listings.district,
	city: listings.city,
	plotAreaM2: listings.plotAreaM2,
	buildingType: listings.buildingType,
	adminFee: listings.adminFee,
	deposit: listings.deposit,
	advertiserType: listings.advertiserType,
	auctionType: listings.auctionType,
	auctionDate: listings.auctionDate,
	listedAt: listings.listedAt,
	firstSeenAt: listings.firstSeenAt,
	heatingType: listings.heatingType,
	propertyType: listings.propertyType,
	propertyKind: listings.propertyKind,
	features: listings.features,
	constructionEndLabel: listings.constructionEndLabel,
	constructionEndDate: listings.constructionEndDate,
	offerType: listings.offerType,
};

async function loadTable(
	url: URL,
	search: ReturnType<typeof listingSearchSchema.parse>,
	filters: ListingFilters,
): Promise<ListingsTableResponse> {
	const pageSize = Math.min(
		500,
		Math.max(1, Number(url.searchParams.get("pageSize") ?? "100") || 100),
	);
	const where = listingFilterSql(filters);
	const facets = await cachedFacets(filters.days);
	const [countRow] = await db
		.select({ count: sql<number>`count(*)` })
		.from(listings)
		.where(where);
	const total = Number(countRow?.count ?? 0);
	const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
	const page = Math.min(search.page ?? 0, maxPage);
	const rows = await db
		.select(tableColumns)
		.from(listings)
		.where(where)
		.orderBy(desc(listings.scrapedAt))
		.limit(pageSize)
		.offset(page * pageSize);
	return {
		listings: rows.map((row) => ({
			...row,
			listedAt: iso(row.listedAt),
			firstSeenAt: iso(row.firstSeenAt),
			auctionDate: iso(row.auctionDate),
			features: clientFeatures(row),
			propertyKind: row.propertyKind as PropertyKind | null,
		})),
		total,
		page,
		pageSize,
		facets: {
			total: facets.total,
			bySource: facets.bySource,
			byKind: facets.byKind as Record<string, number>,
		},
		generatedAt: new Date().toISOString(),
	};
}

export const Route = createFileRoute("/api/listings")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				await ensureListingDerived();
				const url = new URL(request.url);
				const search = listingSearchSchema.parse(
					Object.fromEntries(url.searchParams),
				);
				const filters = filtersFromSearch(search);
				const view = url.searchParams.get("view") ?? "map";

				if (view === "detail") {
					const rawId = url.searchParams.get("id");
					const id = rawId == null ? Number.NaN : Number(rawId);
					if (!Number.isFinite(id) || id <= 0) {
						return json({ error: "id required" }, { status: 400 });
					}
					const listing = await loadDetail(id);
					if (!listing) {
						return json({ error: "not found" }, { status: 404 });
					}
					return json({ listing, generatedAt: new Date().toISOString() });
				}

				if (view === "facets") {
					return json(await cachedFacets(filters.days));
				}

				if (view === "table") {
					return json(await loadTable(url, search, filters));
				}

				const hasBbox = hasBboxParams(url.searchParams);
				const bbox = parseBbox(url.searchParams);
				if (hasBbox && !bbox) {
					return json({ error: "invalid bbox" }, { status: 400 });
				}
				const area = bbox ?? DEFAULT_BBOX;
				const zoomValue = Number(url.searchParams.get("zoom") ?? "8.5");
				const zoom = Number.isFinite(zoomValue)
					? Math.min(19, Math.max(4, zoomValue))
					: 8.5;
				const cacheKey = [
					"listings-map-v2",
					[area.minLng, area.minLat, area.maxLng, area.maxLat]
						.map((value) => value.toFixed(4))
						.join(","),
					zoom.toFixed(2),
					filters.source,
					filters.kind,
					filters.offerType,
					filters.days,
				].join(":");
				const feed = await withCache(cacheKey, MAP_CACHE_TTL_MS, async () => {
					let mode: MapFeedResponse["mode"] = "points";
					let points: MapFeedPoint[] = [];
					let capped = false;
					if (zoom >= MAP_EXACT_MIN_ZOOM) {
						const exact = await loadExactPoints(filters, area);
						if (exact.capped) {
							mode = "clusters";
							capped = true;
							points = await loadClusters(filters, area, zoom);
						} else {
							points = exact.points;
						}
					} else {
						mode = "clusters";
						points = await loadClusters(filters, area, zoom);
					}
					// Court-auction and construction threads keep their own
					// symbols at every zoom; they are never folded into a cell,
					// so cluster mode appends them as exact points. Exact mode
					// already returned them with the rest of the viewport.
					if (mode === "clusters") {
						points = points.concat(await loadSpecialPoints(filters, area));
					}
					const response: MapFeedResponse = {
						mode,
						points,
						...(capped ? { capped: true } : {}),
						generatedAt: new Date().toISOString(),
					};
					const body = JSON.stringify(response);
					return { body, gzip: await gzipJson(body) };
				});
				return jsonResponse(feed.body, request, feed.gzip);
			},
		},
	},
});
