import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { eq, sql } from "drizzle-orm";
import { HIDDEN_SOURCES } from "#/crawler/hidden-sources";
import { db } from "#/db/index";
import { transactionSummaryByBuilding } from "#/db/queries/transaction-history";
import { buildings, listings } from "#/db/schema";
import {
	filterListings,
	filtersFromSearch,
	listingFacets,
	listingSearchSchema,
	parseListingFeatures,
} from "#/lib/listing-features";
import { propertyKindOf } from "#/lib/property-kind";
import { withCache } from "#/lib/server-cache";
import { gzipJson, jsonResponse } from "#/lib/server-response";
import type { ListingAttributesDto } from "#/types/listing";

/** Normalize a string for cross-source matching: lowercase, no
 * diacritics, alphanumerics only, single spaces. */
function normKey(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const STREET_PREFIXES = /^(ul|al|pl|os|skr|bulw|aleja|bulwar|osiedle)\s+/;

/** Split "Meiera 70, Prądnik Biały" into normalized street + housenumber
 * ("meiera", "70"). Returns null when no street is present. */
function parseStreetNumber(address: string | null): {
	street: string;
	number: string | null;
} | null {
	if (!address) return null;
	const first = address.split(",")[0] ?? "";
	const keyed = normKey(first);
	const street = keyed
		.replace(STREET_PREFIXES, "")
		.replace(/\s*\d+[a-z]?(?:\s+[a-z]?\d+[a-z]?)*$/, "")
		.trim();
	if (!street) return null;
	const numMatch = keyed.match(/\d+[a-z]?(?:\s+[a-z]?\d+[a-z]?)*$/);
	// Number key collapses separators: "6a, 6b" -> "6a6b".
	const number = numMatch
		? numMatch[0].replace(/[\s/,]/g, "").toLowerCase()
		: null;
	return { street, number };
}

/**
 * `features` is a full scraper payload, but the client only reads the
 * amenities preview for Airbnb and the forum posts for Budujesie. Investmap
 * features are only needed server-side (investment-id dedupe), so dropping
 * them here removes several MB from the map/table feed without changing a
 * popup.
 */
function clientFeatures(row: {
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

function iso(value: Date | string | null): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function loadRawRows() {
	return (
		db
			.select({
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
				// Investment construction timeline (investmap `finish`
				// "realizacja"): label as published ("I kw. 2026") plus
				// its quarter-start date ("2026-01-01").
				constructionEndLabel: listings.constructionEndLabel,
				constructionEndDate: listings.constructionEndDate,
			})
			.from(listings)
			.leftJoin(buildings, eq(listings.buildingId, buildings.id))
			// All rows: the map filters coordinate-less offers client-side,
			// the listings table shows them regardless.
			.orderBy(sql`${listings.scrapedAt} desc`)
	);
}

type RawListing = Omit<
	Awaited<ReturnType<typeof loadRawRows>>[number],
	"listedAt" | "firstSeenAt"
> & {
	listedAt: string | null;
	firstSeenAt: string | null;
};

/**
 * Columns promoted from `features` for the popup. The map feed has no use
 * for them as top-level row fields, so it ships a compact `attributes`
 * object with only the present values instead of 35 mostly-null columns on
 * every one of ~30k rows.
 */
const ATTRIBUTE_KEYS = [
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

function popupAttributes(row: RawListing): ListingAttributesDto {
	const out: ListingAttributesDto = {};
	for (const key of ATTRIBUTE_KEYS) {
		const value = row[key];
		if (value == null || value === false || value === 0) continue;
		Object.assign(out, {
			[key]: value instanceof Date ? value.toISOString() : value,
		});
	}
	return out;
}

type KindedListing = RawListing & {
	propertyKind: ReturnType<typeof propertyKindOf>;
};

function kindOf(row: RawListing): KindedListing {
	return {
		...row,
		propertyKind: propertyKindOf({
			source: row.source,
			title: row.title,
			propertyType: row.propertyType,
			externalId: row.externalId,
		}),
	};
}

/**
 * Shared dedupe pipeline for both feeds. `view=table` still needs the same
 * visible set; the branch only changes which columns are shipped.
 */
async function loadVisibleRows(): Promise<RawListing[]> {
	const raw = await loadRawRows();
	const rows: RawListing[] = raw.map((row) => ({
		...row,
		listedAt: iso(row.listedAt),
		firstSeenAt: iso(row.firstSeenAt),
	}));
	const notHidden = rows.filter((row) => !HIDDEN_SOURCES.has(row.source));

	// Investmap investment-level rows (`inv-<id>`) stand in for the
	// investment until its flats appear: once any flat row carries the same
	// features.investment_id, the flat rows are the representation and the
	// stand-in goes away.
	const investmapFlatIds = new Set<string>();
	const investmapFlatTitles = new Set<string>();
	for (const row of notHidden) {
		if (row.source !== "investmap" || row.externalId.startsWith("inv-")) {
			continue;
		}
		// The adapter prefixes every flat title with the investment name and
		// an em dash; the title link also covers legacy rows whose features
		// predate the investment_id marker.
		investmapFlatTitles.add(row.title.split(" — ")[0] ?? "");
		const features = parseListingFeatures(row.features);
		const investmentId = features.investmap?.investmentId;
		if (investmentId) investmapFlatIds.add(investmentId);
	}
	const visibleRows = notHidden.filter(
		(row) =>
			!(
				row.source === "investmap" &&
				row.externalId.startsWith("inv-") &&
				(investmapFlatIds.has(row.externalId.slice("inv-".length)) ||
					investmapFlatTitles.has(row.title))
			),
	);

	// Investmap covers rynekpierwotny investments with per-flat detail.
	const investmapRows = visibleRows.filter((row) => row.source === "investmap");
	const rpStreetsWithNumber = new Set<string>();
	const rpStreetsOnly = new Set<string>();
	const rpTitles = new Set<string>();
	for (const row of investmapRows) {
		const address = parseStreetNumber(row.address);
		if (address?.street && address.number) {
			rpStreetsWithNumber.add(`${address.street}|${address.number}`);
			rpStreetsOnly.add(address.street);
		} else if (address?.street) {
			rpStreetsOnly.add(address.street);
		}
		const title = normKey(row.title.split("—")[0] ?? "");
		if (title) rpTitles.add(title);
	}
	const coveredByInvestmap = (row: RawListing): boolean => {
		if (row.source !== "rynekpierwotny") return false;
		const address = parseStreetNumber(row.address);
		if (address?.street && address.number) {
			if (rpStreetsWithNumber.has(`${address.street}|${address.number}`)) {
				return true;
			}
		} else if (address?.street && rpStreetsOnly.has(address.street)) {
			return true;
		}
		return rpTitles.has(normKey(row.title));
	};

	// Morizon and Gratka share the same feed; keep morizon, drop its gratka
	// duplicate.
	const seen = new Set<string>();
	return visibleRows.filter((row) => {
		if (coveredByInvestmap(row)) return false;
		const key = [row.price, row.areaM2, row.rooms, row.district].join("|");
		if (row.source === "morizon") {
			seen.add(key);
			return true;
		}
		if (row.source === "gratka" && seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function tableRow(row: KindedListing) {
	return {
		id: row.id,
		source: row.source,
		externalId: row.externalId,
		url: row.url,
		title: row.title,
		price: row.price,
		pricePerM2: row.pricePerM2,
		areaM2: row.areaM2,
		rooms: row.rooms,
		floor: row.floor,
		district: row.district,
		city: row.city,
		plotAreaM2: row.plotAreaM2,
		buildingType: row.buildingType,
		adminFee: row.adminFee,
		deposit: row.deposit,
		advertiserType: row.advertiserType,
		auctionType: row.auctionType,
		auctionDate: iso(row.auctionDate),
		listedAt: row.listedAt,
		firstSeenAt: row.firstSeenAt,
		heatingType: row.heatingType,
		propertyType: row.propertyType,
		propertyKind: row.propertyKind,
		features: clientFeatures(row),
		constructionEndLabel: row.constructionEndLabel,
		constructionEndDate: row.constructionEndDate,
		offerType: row.offerType,
	};
}

export const Route = createFileRoute("/api/listings")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const search = listingSearchSchema.parse(
					Object.fromEntries(url.searchParams),
				);
				const filters = filtersFromSearch(search);
				const view = url.searchParams.get("view") === "table" ? "table" : "map";

				if (view === "table") {
					const rows = (await loadVisibleRows()).map(kindOf);
					const pageSize = Math.min(
						500,
						Math.max(
							1,
							Number(url.searchParams.get("pageSize") ?? "100") || 100,
						),
					);
					const facets = listingFacets(rows, filters.days);
					const filtered = filterListings(rows, filters);
					const total = filtered.length;
					const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
					const page = Math.min(search.page ?? 0, maxPage);
					const start = page * pageSize;
					return json({
						listings: filtered.slice(start, start + pageSize).map(tableRow),
						total,
						page,
						pageSize,
						facets: {
							total: facets.total,
							bySource: Object.fromEntries(facets.bySource),
							byKind: Object.fromEntries(facets.byKind),
						},
						generatedAt: new Date().toISOString(),
					});
				}

				// Map feed: every point, the per-building RCN summary and the
				// map anchor. It is the one multi-megabyte response (35 MB raw,
				// ~3.9 MB gzipped), so cache the serialized/gzipped body for a
				// minute instead of rebuilding and recompressing on every load.
				const feed = await withCache("listings-map", 60_000, async () => {
					const rows = (await loadVisibleRows()).map(kindOf);
					const buildingIds = [
						...new Set(
							rows
								.map((row) => row.buildingId)
								.filter((value): value is number => value != null),
						),
					];
					const summaryByBuilding = new Map(
						(await transactionSummaryByBuilding(buildingIds)).map((summary) => [
							String(summary.buildingId),
							summary,
						]),
					);
					const body = JSON.stringify({
						listings: rows.map((row) => {
							// Keep the map row lean: the promoted columns move into
							// `attributes` instead of duplicating at the top level.
							const base: Record<string, unknown> = { ...row };
							for (const key of ATTRIBUTE_KEYS) delete base[key];
							const attributes = popupAttributes(row);
							return {
								...base,
								attributes:
									Object.keys(attributes).length > 0 ? attributes : undefined,
								features: clientFeatures(row),
								mapLat: row.buildingLat ?? row.lat,
								mapLng: row.buildingLng ?? row.lng,
								transactionStats: row.buildingId
									? (summaryByBuilding.get(String(row.buildingId)) ?? null)
									: null,
							};
						}),
						generatedAt: new Date().toISOString(),
					});
					return { body, gzip: await gzipJson(body) };
				});
				return jsonResponse(feed.body, request, feed.gzip);
			},
		},
	},
});
