import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import { db } from "#/db/index";
import { listingAlerts, listingScores, listings } from "#/db/schema";
import { loadScoredFacts, type ScoredFacts } from "#/lib/llm/fact-access";
import { nearestCentreAnchor } from "#/lib/scoring/centre-zone";
import { ALERT_TOP_OFFERS, SCORE_VERSION } from "#/lib/scoring/config";
import { nearestFastRail } from "#/lib/scoring/fast-rail";
import { HEATING_LABELS, resolveHeatingEvidence } from "#/lib/scoring/heating";
import type {
	AlertAmenities,
	AlertComparable,
	AlertDto,
	AlertFacts,
	AlertLocation,
	AlertProperties,
	AlertsResponse,
	AlertValuation,
} from "#/types/alerts";

/** An alert is "fresh" while its row is younger than this window. */
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Current-version score row for the same listing. Used only for the sample
 * size and named amenities, which describe the valuation rather than the
 * alert policy of the version that raised the alert.
 */
const latestScore = alias(listingScores, "latest_score");

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
						valuationJson: listingScores.valuationJson,
						compCount: listingScores.compCount,
						compRcnCount: listingScores.compRcnCount,
						eligible: listingScores.eligible,
						/**
						 * Comparable evidence from the listing's current-version score row.
						 * An alert computed under an older SCORE_VERSION keeps its own
						 * scores, but the sample size and named amenities describe the
						 * valuation, not the policy, so the newest evidence is shown.
						 */
						latestCompCount: latestScore.compCount,
						latestCompRcnCount: latestScore.compRcnCount,
						latestAmenitiesJson: latestScore.amenitiesJson,
						listings: {
							buildYear: listings.buildYear,
							heatingType: listings.heatingType,
							description: listings.description,
							featuresHeating: sql<
								string | null
							>`case when json_valid(${listings.features}) then json_extract(${listings.features}, '$.heating') end`,
							buildingType: listings.buildingType,
							buildingMaterial: listings.buildingMaterial,
							condition: listings.condition,
							ownership: listings.ownership,
							floorCount: listings.floorCount,
							plotAreaM2: listings.plotAreaM2,
							market: listings.market,
							hasElevator: listings.hasElevator,
							hasParking: listings.hasParking,
							hasGarage: listings.hasGarage,
							hasBasement: listings.hasBasement,
							hasBalcony: listings.hasBalcony,
							hasTerrace: listings.hasTerrace,
							hasGarden: listings.hasGarden,
						},
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
					.leftJoin(
						latestScore,
						and(
							eq(latestScore.listingId, listingAlerts.listingId),
							eq(latestScore.scoreVersion, SCORE_VERSION),
						),
					)
					.where(and(...filters))
					.orderBy(
						asc(listingAlerts.region),
						asc(listingAlerts.segment),
						asc(listingAlerts.rank),
					);

				const kept = capPerSegment(rows);
				// One chunked read for the whole page: the projection below turns
				// the extracted facts into the card's risk/setting/cost lines.
				const factsById = await loadScoredFacts(
					kept.map((row) => row.listingId),
				);
				const alerts: AlertDto[] = kept.map((row) => {
					const createdAt = row.alertCreatedAt?.toISOString() ?? null;
					const payload = parseJson<Record<string, unknown>>(
						row.payloadJson,
						{},
					);
					const amenities = mergeAmenities(
						parseAmenities(row.amenitiesJson),
						parseAmenities(row.latestAmenitiesJson),
					);
					return {
						id: row.id,
						alertDate: row.alertDate,
						alertCreatedAt: createdAt ?? generatedAt.toISOString(),
						rank: row.rank,
						score: row.score,
						/** True for an offer that fills a section without heating proof. */
						heatingUnknown: payload.heatingUnknown === true,
						eligible: row.eligible ?? true,
						fallbackReason:
							row.eligible === false
								? row.segment === "flat"
									? "heating"
									: "evidence"
								: null,
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
						amenities,
						properties: toProperties(row.listings),
						compCount: preferEvidence(row.latestCompCount, row.compCount),
						compRcnCount: preferEvidence(
							row.latestCompRcnCount,
							row.compRcnCount,
						),
						listedAt: row.listedAt?.toISOString() ?? null,
						firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
						location: toLocation(row),
						facts: toFacts(factsById.get(row.listingId) ?? null, amenities),
						valuation: parseValuation(row.valuationJson),
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

/** A stored number, or null for a missing/non-finite value. */
function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Comparable rows kept in a stored valuation; the engine cuts at the same size. */
const MAX_COMPARABLES = 30;

/**
 * The comparable sample stored with a score. Rows are written by our own
 * scoring run, but the payload is still checked field by field so a malformed
 * blob degrades to an empty list instead of a broken card.
 */
function parseComparables(value: unknown): AlertComparable[] {
	if (!Array.isArray(value)) return [];
	const out: AlertComparable[] = [];
	for (const raw of value.slice(0, MAX_COMPARABLES)) {
		if (raw == null || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		const id = typeof record.id === "string" ? record.id : null;
		const source = record.source;
		const priceM2 = finiteNumber(record.priceM2);
		if (
			id == null ||
			(source !== "rcn" && source !== "listing") ||
			priceM2 == null
		) {
			continue;
		}
		out.push({
			id,
			source,
			date: typeof record.date === "string" ? record.date : null,
			distanceM: finiteNumber(record.distanceM),
			areaM2: finiteNumber(record.areaM2),
			rooms: finiteNumber(record.rooms),
			address:
				typeof record.address === "string" && record.address.length > 0
					? record.address
					: null,
			priceM2,
			// A row without an adjusted price is its own adjusted price: no
			// correction applied, so the card shows no "→" suffix.
			adjustedPriceM2: finiteNumber(record.adjustedPriceM2) ?? priceM2,
			timeFactor: finiteNumber(record.timeFactor) ?? 1,
			askingRatio: finiteNumber(record.askingRatio),
		});
	}
	return out;
}

function countBy(
	alerts: AlertDto[],
	key: (alert: AlertDto) => string,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const alert of alerts) out[key(alert)] = (out[key(alert)] ?? 0) + 1;
	return out;
}

/**
 * Amenity evidence as stored with a score. Values are passed through
 * untouched: the payload shape is additive and older rows only carry
 * distances, so a missing name stays missing rather than being guessed.
 */
function parseAmenities(value: string | null): AlertAmenities | null {
	if (value == null) return null;
	const parsed = parseJson<Record<string, unknown> | null>(value, null);
	if (parsed == null || typeof parsed !== "object") return null;
	if (Object.keys(parsed).length === 0) return null;
	return parsed as AlertAmenities;
}

/**
 * Keep the best `ALERT_TOP_OFFERS` rows per segment. The engine already cuts
 * the pool at that size, but a date can hold rows from an older cut rule (or
 * fresh-arrival extras), and the page promises a readable leaderboard per
 * category, so the feed enforces the same ceiling.
 */
function capPerSegment<
	T extends { segment: string; score: number; eligible?: boolean },
>(rows: readonly T[]): T[] {
	const bySegment = new Map<string, T[]>();
	for (const row of rows) {
		const group = bySegment.get(row.segment) ?? [];
		group.push(row);
		bySegment.set(row.segment, group);
	}
	const kept = new Set<T>();
	for (const group of bySegment.values()) {
		// A fully eligible offer keeps its rank over a fallback one that fills
		// a short section, whatever the score says.
		for (const row of group
			.slice()
			.sort(
				(left, right) =>
					Number(right.eligible ?? true) - Number(left.eligible ?? true) ||
					right.score - left.score,
			)
			.slice(0, ALERT_TOP_OFFERS)) {
			kept.add(row);
		}
	}
	return rows.filter((row) => kept.has(row));
}

/**
 * A zero count means "not recorded" (the score predates the column), so the
 * newest non-zero sample wins. The alert's own row stays authoritative for
 * every score value.
 */
function preferEvidence(latest: number | null, stored: number | null): number {
	if (latest != null && latest > 0) return latest;
	return stored ?? 0;
}

const AMENITY_LATEST_KEYS = [
	"parkName",
	"forestName",
	"waterName",
	"riverName",
	"stationName",
	"transitName",
	"tramName",
	"busName",
	// House extras: an alert raised before the fields existed still shows the
	// current-version measurement rather than nothing.
	"neighbourM",
	"neighbours150m",
	"strNightly",
	"strSample",
] as const;

/**
 * Fill values missing from the alert's own payload with the listing's latest
 * score row. Distances are kept from the alert's row: only names and the
 * house extras are lifted, and only where the alert row has none.
 */
function mergeAmenities(
	base: AlertAmenities | null,
	latest: AlertAmenities | null,
): AlertAmenities | null {
	if (base == null) return latest;
	if (latest == null) return base;
	const merged = { ...base };
	for (const key of AMENITY_LATEST_KEYS) {
		const value = latest[key];
		if (merged[key] == null && value != null) {
			Object.assign(merged, { [key]: value });
		}
	}
	return merged;
}

/** The listing columns the alert card renders as physical facts. */
interface ListingFactColumns {
	buildYear: number | null;
	heatingType: string | null;
	description: string | null;
	featuresHeating: string | null;
	buildingType: string | null;
	buildingMaterial: string | null;
	condition: string | null;
	ownership: string | null;
	floorCount: number | null;
	plotAreaM2: number | null;
	market: string | null;
	hasElevator: boolean | null;
	hasParking: boolean | null;
	hasGarage: boolean | null;
	hasBasement: boolean | null;
	hasBalcony: boolean | null;
	hasTerrace: boolean | null;
	hasGarden: boolean | null;
}

/** Nullable columns become plain booleans; absent flags stay false. */
function toProperties(listing: ListingFactColumns): AlertProperties {
	// The heating column is mostly empty for the bulk portals, so the card
	// shows the resolved kind and marks prose-sourced evidence as such.
	const heating = resolveHeatingEvidence({
		heatingType: listing.heatingType,
		featuresHeating: listing.featuresHeating,
	});
	const heatingLabel =
		heating.kind === "unknown"
			? null
			: heating.source === "facts"
				? `${HEATING_LABELS[heating.kind]} (z opisu)`
				: HEATING_LABELS[heating.kind];
	return {
		buildYear: listing.buildYear,
		heatingType: listing.heatingType,
		heatingLabel,
		buildingType: listing.buildingType,
		buildingMaterial: listing.buildingMaterial,
		condition: listing.condition,
		ownership: listing.ownership,
		floorCount: listing.floorCount,
		plotAreaM2: listing.plotAreaM2,
		market: listing.market,
		hasElevator: Boolean(listing.hasElevator),
		hasParking: Boolean(listing.hasParking),
		hasGarage: Boolean(listing.hasGarage),
		hasBasement: Boolean(listing.hasBasement),
		hasBalcony: Boolean(listing.hasBalcony),
		hasTerrace: Boolean(listing.hasTerrace),
		hasGarden: Boolean(listing.hasGarden),
	};
}

/**
 * Where the offer sits relative to the two location rules: fast-rail access
 * (plots and houses) and the centre zone (flats). Recomputed per request from
 * the listing coordinates and the curated datasets, so editing a station or an
 * anchor never requires a re-score.
 */
function toLocation(row: {
	segment: string;
	lat: number | null;
	lng: number | null;
	city: string | null;
}): AlertLocation {
	if (row.segment === "apartment" || row.segment === "flat") {
		const zone = nearestCentreAnchor(row.lat, row.lng, row.city);
		return {
			fastRail: null,
			centreZone:
				zone == null
					? null
					: { name: zone.anchor.name, distanceM: Math.round(zone.distanceM) },
		};
	}
	const rail = nearestFastRail(row.lat, row.lng);
	return {
		fastRail:
			rail == null
				? null
				: {
						name: rail.station.name,
						city: rail.station.city,
						distanceM: Math.round(rail.distanceM),
						kdpPlanned: rail.kdpPlanned,
						kdpYear: rail.station.kdpYear,
					},
		centreZone: null,
	};
}

/** Card projection of the extracted facts; empty arrays when nothing was read. */
function toFacts(
	facts: ScoredFacts | null,
	amenities: AlertAmenities | null,
): AlertFacts {
	const plot = facts?.plot ?? null;
	const context = facts?.context ?? null;
	const setting: string[] = [];
	if (context?.lake) setting.push("jezioro");
	if (context?.river) setting.push("rzeka");
	if (context?.forest) setting.push("las");
	if (context?.mountains) setting.push("góry");
	if (context?.view != null && context.view.length > 0) {
		setting.push(`widok: ${context.view}`);
	}
	return {
		risks: [...(facts?.defects ?? []), ...(facts?.encumbrances ?? [])],
		setting,
		plotMedia: plot?.mediaCount ?? null,
		plotAccess: plot?.roadAccess ?? null,
		monthlyRent: facts?.monthlyCosts?.rent ?? null,
		funduszRemontowy: facts?.monthlyCosts?.funduszRemontowy ?? null,
		legalStatus: facts?.legalStatus ?? null,
		...houseExtras(amenities),
	};
}

/**
 * House solitude and rental-market evidence carried in the amenities blob.
 * Values are numbers by construction; anything else becomes null so the card
 * never prints a fabricated distance or price.
 */
function houseExtras(
	amenities: AlertAmenities | null,
): Pick<
	AlertFacts,
	"neighbourM" | "neighbours150m" | "strNightly" | "strSample"
> {
	return {
		neighbourM: finiteNumber(amenities?.neighbourM),
		neighbours150m: finiteNumber(amenities?.neighbours150m),
		strNightly: finiteNumber(amenities?.strNightly),
		strSample: finiteNumber(amenities?.strSample),
	};
}

/** Stored valuation evidence; `{}` (a pre-column score row) yields null. */
function parseValuation(value: string | null): AlertValuation | null {
	if (value == null) return null;
	const parsed = parseJson<Record<string, unknown> | null>(value, null);
	if (parsed == null || typeof parsed !== "object") return null;
	if (parsed.qualityPct == null) return null;
	const record = parsed as Record<string, unknown>;
	const span = record.indexSpan as { from?: unknown; to?: unknown } | null;
	return {
		qualityPct: Number(record.qualityPct ?? 0),
		qualityKnown: record.qualityKnown === true,
		qualityReasons: Array.isArray(record.qualityReasons)
			? (record.qualityReasons as AlertValuation["qualityReasons"])
			: [],
		comparables: parseComparables(record.comparables),
		timeFactorMedian:
			typeof record.timeFactorMedian === "number"
				? record.timeFactorMedian
				: null,
		indexSpan:
			typeof span?.from === "string" && typeof span?.to === "string"
				? { from: span.from, to: span.to }
				: null,
		askingRatio:
			typeof record.askingRatio === "number" ? record.askingRatio : null,
		askingRatioSource:
			record.askingRatioSource === "measured" ||
			record.askingRatioSource === "fallback"
				? record.askingRatioSource
				: null,
		compAgeMedianYears:
			typeof record.compAgeMedianYears === "number"
				? record.compAgeMedianYears
				: null,
	};
}
