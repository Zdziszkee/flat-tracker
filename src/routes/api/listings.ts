import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, listings, transactions } from "#/db/schema";

interface BuildingSummary {
	buildingId: number | null;
	address: string | null;
	txCount: number;
	txAvgPricePerM2: number | null;
	txMinDate: string | null;
	txMaxDate: string | null;
}

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

function transactionSummary(): Promise<BuildingSummary[]> {
	return db
		.select({
			buildingId: transactions.buildingId,
			address: buildings.address,
			txCount: sql<number>`count(${transactions.id})`,
			txAvgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
			// `date` is a unix timestamp; render as YYYY-MM-DD strings so the
			// client can slice years without type gymnastics.
			txMinDate: sql<
				string | null
			>`strftime('%Y-%m-%d', min(${transactions.date}), 'unixepoch')`,
			txMaxDate: sql<
				string | null
			>`strftime('%Y-%m-%d', max(${transactions.date}), 'unixepoch')`,
		})
		.from(transactions)
		.innerJoin(buildings, eq(transactions.buildingId, buildings.id))
		.where(and(isNotNull(transactions.buildingId), isNotNull(transactions.lat)))
		.groupBy(transactions.buildingId)
		.orderBy(sql`count(${transactions.id}) desc`);
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
					})
					.from(listings)
					.leftJoin(buildings, eq(listings.buildingId, buildings.id))
					// All rows: the map filters coordinate-less offers
					// client-side, the listings table shows them regardless.
					.orderBy(sql`${listings.scrapedAt} desc`);

				const summary = await transactionSummary();

				const summaryByBuilding = new Map(
					summary.map((s) => [String(s.buildingId), s]),
				);

				// Investmap covers rynekpierwotny's investments with per-flat
				// detail, so a rynekpierwotny project row is dropped when the
				// same investment is present on investmap (exact street +
				// housenumber, or the same investment name, or a street-only
				// match when the project has no housenumber).
				const investmapRows = rows.filter((r) => r.source === "investmap");
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
				const coveredByInvestmap = (r: (typeof rows)[number]): boolean => {
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
				const unique = rows.filter((r) => {
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

				return json({
					listings: unique.map((r) => ({
						...r,
						// Prefer building centroid (assigned via point-in-polygon) as the
						// map anchor: offers are shown on the building they belong to.
						mapLat: r.buildingLat ?? r.lat,
						mapLng: r.buildingLng ?? r.lng,
						transactionStats: r.buildingId
							? (summaryByBuilding.get(String(r.buildingId)) ?? null)
							: null,
					})),
					summary,
					generatedAt: new Date().toISOString(),
				});
			},
		},
	},
});
