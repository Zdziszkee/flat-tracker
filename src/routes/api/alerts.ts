import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, asc, desc, eq, type SQL } from "drizzle-orm";

import { db } from "#/db/index";
import { listingAlerts, listingScores, listings } from "#/db/schema";
import type { AlertDto, AlertsResponse } from "#/types/alerts";

/** An alert is "fresh" while its row is younger than this window. */
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Shared daily alert feed. Defaults to the latest alert date and supports
 * optional region and segment filters.
 */
export const Route = createFileRoute("/api/alerts")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const generatedAt = new Date();
				const params = new URL(request.url).searchParams;
				const requestedDate = params.get("date");
				const region = params.get("region");
				const segment = params.get("segment");

				let date = requestedDate;
				if (!date) {
					const latest = await db
						.select({ date: listingAlerts.alertDate })
						.from(listingAlerts)
						.orderBy(desc(listingAlerts.alertDate))
						.limit(1);
					date = latest[0]?.date ?? new Date().toISOString().slice(0, 10);
				}

				const filters: SQL[] = [eq(listingAlerts.alertDate, date)];
				if (region) filters.push(eq(listingAlerts.region, region));
				if (segment) filters.push(eq(listingAlerts.segment, segment));

				const rows = await db
					.select({
						id: listingAlerts.id,
						alertDate: listingAlerts.alertDate,
						alertCreatedAt: listingAlerts.createdAt,
						rank: listingAlerts.rank,
						score: listingAlerts.score,
						payloadJson: listingAlerts.payloadJson,
						segment: listingScores.segment,
						region: listingScores.region,
						discountPct: listingScores.discountPct,
						fairPrice: listingScores.fairPrice,
						fairM2: listingScores.fairM2,
						askingPrice: listingScores.askingPrice,
						confidence: listingScores.confidence,
						valueScore: listingScores.valueScore,
						transitScore: listingScores.transitScore,
						greenScore: listingScores.greenScore,
						propertyScore: listingScores.propertyScore,
						riskScore: listingScores.riskScore,
						reasonsJson: listingScores.reasonsJson,
						amenitiesJson: listingScores.amenitiesJson,
						flagsJson: listingScores.flagsJson,
						listingId: listings.id,
						source: listings.source,
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
						propertyKind: listings.propertyKind,
						offerType: listings.offerType,
						firstSeenAt: listings.firstSeenAt,
						listedAt: listings.listedAt,
					})
					.from(listingAlerts)
					.innerJoin(listingScores, eq(listingAlerts.scoreId, listingScores.id))
					.innerJoin(listings, eq(listingAlerts.listingId, listings.id))
					.where(and(...filters))
					.orderBy(
						asc(listingAlerts.region),
						asc(listingAlerts.segment),
						asc(listingAlerts.rank),
					);

				const alerts: AlertDto[] = rows.map((row) => {
					const createdAt = row.alertCreatedAt?.toISOString() ?? null;
					const payload = parseJson<Record<string, unknown>>(
						row.payloadJson,
						{},
					);
					return {
						id: row.id,
						alertDate: row.alertDate,
						alertCreatedAt: createdAt ?? generatedAt.toISOString(),
						rank: row.rank,
						score: row.score,
						segment: row.segment as AlertDto["segment"],
						region: row.region,
						discountPct: row.discountPct,
						fairPrice: row.fairPrice,
						fairM2: row.fairM2,
						askingPrice: row.askingPrice,
						confidence: row.confidence,
						valueScore: row.valueScore,
						transitScore: row.transitScore,
						greenScore: row.greenScore,
						propertyScore: row.propertyScore,
						riskScore: row.riskScore,
						reasons: parseJson(row.reasonsJson, []),
						flags: parseJson(row.flagsJson, []),
						amenities: parseJson(row.amenitiesJson, null),
						listedAt: row.listedAt?.toISOString() ?? null,
						firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
						isFresh:
							createdAt != null &&
							generatedAt.getTime() - Date.parse(createdAt) < FRESH_WINDOW_MS,
						reason: typeof payload.reason === "string" ? payload.reason : null,
						listing: {
							id: row.listingId,
							source: row.source,
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
							propertyKind: row.propertyKind,
							offerType: row.offerType,
							firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
						},
					};
				});

				const freshCount = alerts.filter((alert) => alert.isFresh).length;

				const counts = {
					total: alerts.length,
					byRegion: countBy(alerts, (alert) => alert.region),
					bySegment: countBy(alerts, (alert) => alert.segment),
				};

				return json({
					date,
					generatedAt: generatedAt.toISOString(),
					freshCount,
					alerts,
					counts,
				} satisfies AlertsResponse);
			},
		},
	},
});

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function countBy(
	alerts: AlertDto[],
	key: (alert: AlertDto) => string,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const alert of alerts) out[key(alert)] = (out[key(alert)] ?? 0) + 1;
	return out;
}
