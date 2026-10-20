import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { eq, sql } from "drizzle-orm";
import { HIDDEN_SOURCES } from "#/crawler/hidden-sources";
import { db } from "#/db/index";
import { transactionSummaryByBuilding } from "#/db/queries/transaction-history";
import { buildings, listings } from "#/db/schema";
import { parseListingFeatures } from "#/lib/listing-features";
import { propertyKindOf } from "#/lib/property-kind";

/** Normalize a string for cross-source matching: lowercase, no
 * diacritics, alphanumerics only, single spaces. */
function normKey(s: string): string {
	return s
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

export const Route = createFileRoute("/api/listings")({
	server: {
		handlers: {
			GET: async () => {
				const rows = await db
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
						// its quarter-start date ("2026-01-01"). Null for rows
						// without a published completion.
						constructionEndLabel: listings.constructionEndLabel,
						constructionEndDate: listings.constructionEndDate,
					})
					.from(listings)
					.leftJoin(buildings, eq(listings.buildingId, buildings.id))
					// All rows: the map filters coordinate-less offers
					// client-side, the listings table shows them regardless.
					.orderBy(sql`${listings.scrapedAt} desc`);

				const notHidden = rows.filter((r) => !HIDDEN_SOURCES.has(r.source));

				// Investmap investment-level rows (`inv-<id>`; one price-less pin
				// per investment with no flats for sale, see the adapter's
				// investmentRow) stand in for the investment until its flats
				// appear: once any flat row carries the same
				// features.investment_id, the flat rows are the map's
				// representation of it and the stand-in goes away.
				const investmapFlatIds = new Set<string>();
				const investmapFlatTitles = new Set<string>();
				for (const r of notHidden) {
					if (r.source !== "investmap" || r.externalId.startsWith("inv-"))
						continue;
					// The adapter prefixes every flat title with the investment
					// name and an em dash: the title link also covers legacy flat
					// rows whose features predate the investment_id marker (sold
					// out, never re-emitted) — those would otherwise double-pin
					// with their stand-in forever.
					investmapFlatTitles.add(r.title.split(" — ")[0] ?? "");
					const features = parseListingFeatures(r.features);
					const investmentId = features.investmap?.investmentId;
					if (investmentId) investmapFlatIds.add(investmentId);
				}
				const visibleRows = notHidden.filter(
					(r) =>
						!(
							r.source === "investmap" &&
							r.externalId.startsWith("inv-") &&
							(investmapFlatIds.has(r.externalId.slice("inv-".length)) ||
								investmapFlatTitles.has(r.title))
						),
				);

				// Investmap covers rynekpierwotny's investments with per-flat
				// detail, so a rynekpierwotny project row is dropped when the
				// same investment is present on investmap (exact street +
				// housenumber, or the same investment name, or a street-only
				// match when the project has no housenumber).
				const investmapRows = visibleRows.filter(
					(r) => r.source === "investmap",
				);
				const rpStreetsWithNumber = new Set<string>();
				const rpStreetsOnly = new Set<string>();
				const rpTitles = new Set<string>();
				for (const r of investmapRows) {
					const addr = parseStreetNumber(r.address);
					if (addr?.street && addr.number) {
						rpStreetsWithNumber.add(`${addr.street}|${addr.number}`);
						rpStreetsOnly.add(addr.street);
					} else if (addr?.street) {
						rpStreetsOnly.add(addr.street);
					}
					const title = normKey(r.title.split("—")[0] ?? "");
					if (title) rpTitles.add(title);
				}
				const coveredByInvestmap = (
					r: (typeof visibleRows)[number],
				): boolean => {
					if (r.source !== "rynekpierwotny") return false;
					const addr = parseStreetNumber(r.address);
					if (addr?.street && addr.number) {
						if (rpStreetsWithNumber.has(`${addr.street}|${addr.number}`))
							return true;
					} else if (addr?.street && rpStreetsOnly.has(addr.street)) {
						return true;
					}
					return rpTitles.has(normKey(r.title));
				};

				// Morizon and Gratka share the same feed, so the same offer
				// appears under both sources. Dedupe by natural key
				// (price + area + rooms + district), keeping morizon as the
				// canonical source (it is sorted first by scrapedAt desc).
				const seen = new Set<string>();
				const unique = visibleRows.filter((r) => {
					if (coveredByInvestmap(r)) return false;
					const key = [r.price, r.areaM2, r.rooms, r.district].join("|");
					if (r.source === "morizon") {
						seen.add(key);
						return true;
					}
					if (r.source === "gratka" && seen.has(key)) return false;
					seen.add(key);
					return true;
				});

				// Scope the aggregation to the buildings actually referenced by
				// the surviving rows: only per-listing transactionStats is read
				// downstream, so a region-wide GROUP BY (and shipping it) was
				// pure overhead.
				const buildingIds = [
					...new Set(
						unique
							.map((r) => r.buildingId)
							.filter((x): x is number => x != null),
					),
				];
				const summaryByBuilding = new Map(
					(await transactionSummaryByBuilding(buildingIds)).map((s) => [
						String(s.buildingId),
						s,
					]),
				);

				return json({
					listings: unique.map((r) => ({
						...r,
						// dom / mieszkanie / działka — derived once, here, so
						// map and listings filter on the same classifier.
						propertyKind: propertyKindOf({
							source: r.source,
							title: r.title,
							propertyType: r.propertyType,
							externalId: r.externalId,
						}),
						// Prefer building centroid (assigned via point-in-polygon) as the
						// map anchor: offers are shown on the building they belong to.
						mapLat: r.buildingLat ?? r.lat,
						mapLng: r.buildingLng ?? r.lng,
						transactionStats: r.buildingId
							? (summaryByBuilding.get(String(r.buildingId)) ?? null)
							: null,
					})),
					generatedAt: new Date().toISOString(),
				});
			},
		},
	},
});
