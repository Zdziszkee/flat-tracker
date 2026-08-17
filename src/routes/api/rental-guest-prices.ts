import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { eq, like, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { availability, listings } from "#/db/schema";

/**
 * Per-guest price series: how a 7-night stay's effective nightly price
 * changes with the number of adults (1..max), captured per listing.
 */
export const Route = createFileRoute("/api/rental-guest-prices")({
	server: {
		handlers: {
			GET: async () => {
				const rows = await db
					.select({
						listingId: availability.listingId,
						priceConfig: availability.priceConfig,
						avgEffective: sql<
							number | null
						>`avg(${availability.effectiveNightlyPrice})`,
						avgTotal: sql<number | null>`avg(${availability.totalPrice})`,
						title: sql<string>`max(${listings.title})`,
						source: sql<string>`max(${listings.source})`,
						maxGuests: sql<number | null>`max(${listings.maxGuests})`,
					})
					.from(availability)
					.innerJoin(listings, eq(availability.listingId, listings.id))
					.where(like(availability.priceConfig, "7_nights_%_adults"))
					.groupBy(availability.listingId, availability.priceConfig)
					.all();

				const byListing = new Map<
					number,
					{
						listingId: number;
						title: string;
						source: string;
						maxGuests: number | null;
						guests: Record<number, { avgEffective: number | null }>;
					}
				>();
				for (const r of rows) {
					const adults = Number(r.priceConfig.split("_")[2]);
					if (!Number.isFinite(adults)) continue;
					const entry = byListing.get(r.listingId) ?? {
						listingId: r.listingId,
						title: r.title,
						source: r.source,
						maxGuests: r.maxGuests,
						guests: {},
					};
					entry.guests[adults] = { avgEffective: r.avgEffective };
					byListing.set(r.listingId, entry);
				}

				return json({ rows: [...byListing.values()] });
			},
		},
	},
});
