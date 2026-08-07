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

function transactionSummary(): Promise<BuildingSummary[]> {
	return db
		.select({
			buildingId: transactions.buildingId,
			address: buildings.address,
			txCount: sql<number>`count(${transactions.id})`,
			txAvgPricePerM2: sql<number | null>`avg(${transactions.pricePerM2})`,
			// `date` is a unix timestamp; render as YYYY-MM-DD strings so the
			// client can slice years without type gymnastics.
			txMinDate: sql<string | null>`strftime('%Y-%m-%d', min(${transactions.date}), 'unixepoch')`,
			txMaxDate: sql<string | null>`strftime('%Y-%m-%d', max(${transactions.date}), 'unixepoch')`,
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
						lat: listings.lat,
						lng: listings.lng,
						listedAt: listings.listedAt,
						buildingId: listings.buildingId,
						buildingAddress: buildings.address,
						buildingLat: buildings.lat,
						buildingLng: buildings.lng,
					})
					.from(listings)
					.leftJoin(buildings, eq(listings.buildingId, buildings.id))
					.where(isNotNull(listings.lat))
					.orderBy(sql`${listings.scrapedAt} desc`)
					.limit(6000);

				const summary = await transactionSummary();

				const summaryByBuilding = new Map(
					summary.map((s) => [String(s.buildingId), s]),
				);

				return json({
					listings: rows.map((r) => ({
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
