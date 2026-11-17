/**
 * Alert scoring run.
 *
 * Reads active sale listings, computes a transparent score, stores the
 * component breakdown, ranks within region and segment, and appends new
 * top-5% offers to today's in-app alert list. Runs incrementally after every
 * refresh (only listings without a current-version score are scored) and as
 * a daily task; a listing is alerted at most once.
 */

import { and, desc, eq, gte, isNotNull, or, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { regionOf, type TrackedRegion } from "#/db/region";
import {
	listingAlerts,
	listingScores,
	listings,
	parcelFeatures,
} from "#/db/schema";
import { propertyKindOf } from "#/lib/property-kind";
import {
	type AlertScore,
	type ScoreListingInput,
	scoreAlert,
} from "#/lib/scoring/alert-score";
import {
	ALERT_GATES,
	type AlertSegment,
	SCORE_VERSION,
} from "#/lib/scoring/config";
import { estimateSaleValue } from "#/lib/valuation/offer-model";
import { geoUniqueness } from "#/lib/valuation/uniqueness-geo";

export interface ScoreRunOptions {
	/** Score every active sale listing, not only recently seen ones. */
	all?: boolean;
	/**
	 * Skip listings that already carry a current-version score. This is the
	 * incremental mode the refresh pipeline uses: every new offer is scored
	 * exactly once per score version, existing scores are left untouched.
	 */
	incremental?: boolean;
	/** Lookback for "new" listings, in days. Default 7. */
	days?: number;
	/** Hard cap for a manual/backfill run. */
	limit?: number;
	/** Compute and store scores but do not create alerts. */
	dryRun?: boolean;
	now?: Date;
}

export interface ScoreRunSummary {
	startedAt: string;
	durationMs: number;
	scanned: number;
	scored: number;
	eligible: number;
	alerts: number;
	errors: number;
	bySegment: Record<string, number>;
	byRegion: Record<string, number>;
	firstErrors: string[];
}

const SEGMENT_BY_KIND: Record<string, AlertSegment> = {
	apartment: "flat",
	flat: "flat",
	house: "house",
	plot: "plot",
};

function normalizeRegion(
	value: string | null | undefined,
): TrackedRegion | null {
	const text = value
		?.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
	if (text === "malopolskie") return "malopolskie";
	if (text === "slaskie") return "slaskie";
	return null;
}

function dateOnly(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function segmentLabel(segment: AlertSegment): string {
	return segment;
}

export async function runAlertScoring(
	options: ScoreRunOptions = {},
): Promise<ScoreRunSummary> {
	const started = Date.now();
	const now = options.now ?? new Date();
	const days = options.days ?? 7;
	const cutoff = new Date(now.getTime() - days * 86_400_000);
	const errors: string[] = [];
	const bySegment: Record<string, number> = {};
	const byRegion: Record<string, number> = {};
	let scanned = 0;
	let scored = 0;
	let eligible = 0;

	const filters = [
		eq(listings.offerType, "sale"),
		eq(listings.isActive, true),
		eq(listings.isVisible, true),
		// The derived kind when the listing-derived pass has run, the raw
		// portal type otherwise: scoring must not silently skip a fresh DB
		// whose derived columns have not been recomputed yet.
		or(isNotNull(listings.propertyKind), isNotNull(listings.propertyType)),
		isNotNull(listings.price),
		isNotNull(listings.areaM2),
		isNotNull(listings.pricePerM2),
		sql`${listings.price} > 0`,
		sql`${listings.areaM2} > 0`,
		sql`${listings.pricePerM2} > 0`,
		sql`coalesce(${listings.portalStatus}, '') not in ('sold', 'reserved', 'expired')`,
	];
	if (!options.all && !options.incremental) {
		filters.push(
			sql`coalesce(${listings.firstSeenAt}, ${listings.listedAt}, ${listings.scrapedAt}) >= ${Math.floor(cutoff.getTime() / 1000)}`,
		);
	}
	if (options.incremental) {
		// Only offers without a current-version score. The subquery rides the
		// (listing_id, score_version) unique index.
		filters.push(
			sql`not exists (select 1 from ${listingScores} where ${listingScores.listingId} = ${listings.id} and ${listingScores.scoreVersion} = ${SCORE_VERSION})`,
		);
	}

	let query = db
		.select({
			id: listings.id,
			source: listings.source,
			title: listings.title,
			description: listings.description,
			offerType: listings.offerType,
			price: listings.price,
			pricePerM2: listings.pricePerM2,
			areaM2: listings.areaM2,
			plotAreaM2: listings.plotAreaM2,
			rooms: listings.rooms,
			floor: listings.floor,
			floorCount: listings.floorCount,
			buildYear: listings.buildYear,
			buildingMaterial: listings.buildingMaterial,
			condition: listings.condition,
			ownership: listings.ownership,
			heatingType: listings.heatingType,
			buildingType: listings.buildingType,
			plotType: listings.plotType,
			market: listings.market,
			hasBalcony: listings.hasBalcony,
			hasTerrace: listings.hasTerrace,
			hasGarden: listings.hasGarden,
			hasElevator: listings.hasElevator,
			hasParking: listings.hasParking,
			hasGarage: listings.hasGarage,
			hasBasement: listings.hasBasement,
			auctionType: listings.auctionType,
			lat: listings.lat,
			lng: listings.lng,
			city: listings.city,
			voivodeship: listings.voivodeship,
			buildingId: listings.buildingId,
			district: listings.district,
			propertyKind: listings.propertyKind,
			propertyType: listings.propertyType,
			firstSeenAt: listings.firstSeenAt,
			parcelId: listings.parcelId,
			parcelAreaM2: parcelFeatures.areaM2,
			parcelFrontageM: parcelFeatures.frontageM,
			parcelRoadDistanceM: parcelFeatures.roadDistanceM,
			parcelRoadClass: parcelFeatures.roadClass,
			parcelBuildingCoverage: parcelFeatures.buildingCoverage,
			parcelLandUseClass: parcelFeatures.landUseClass,
			parcelZoningWz: parcelFeatures.zoningWz,
			parcelZoningNoPlan: parcelFeatures.zoningNoPlan,
			parcelZoningPlanCount: parcelFeatures.zoningPlanCount,
			parcelFloodRisk: parcelFeatures.floodRisk,
			parcelSlopeDeg: parcelFeatures.slopeDeg,
			parcelElevationM: parcelFeatures.elevationM,
		})
		.from(listings)
		.leftJoin(parcelFeatures, eq(listings.parcelId, parcelFeatures.parcelId))
		.where(and(...filters))
		.orderBy(desc(listings.firstSeenAt));

	if (options.limit != null && options.limit > 0) {
		query = query.limit(options.limit) as typeof query;
	}

	const rows = await query;
	scanned = rows.length;

	for (const row of rows) {
		try {
			const kind = propertyKindOf({
				source: row.source,
				title: row.title,
				propertyType: row.propertyKind ?? row.propertyType,
			});
			if (!kind) continue;
			const segment = SEGMENT_BY_KIND[kind];
			if (!segment) continue;
			const region =
				normalizeRegion(row.voivodeship) ??
				(row.lat != null && row.lng != null
					? regionOf(row.lat, row.lng)
					: null);
			if (!region) continue;

			const geo =
				row.lat != null && row.lng != null
					? await geoUniqueness(row.lat, row.lng)
					: null;

			const estimateResult = await estimateSaleValue(
				{
					id: row.id,
					source: row.source,
					externalId: String(row.id),
					title: row.title,
					price: row.price,
					pricePerM2: row.pricePerM2,
					areaM2: row.areaM2,
					rooms: row.rooms,
					district: row.district,
					lat: row.lat,
					lng: row.lng,
					buildingId: row.buildingId,
					market: row.market,
					plotType: row.plotType,
					kind: segment,
				},
				now,
				{ includeUpside: false },
			);

			const input: ScoreListingInput = {
				id: row.id,
				source: row.source,
				segment,
				region,
				city: row.city,
				title: row.title,
				description: row.description,
				price: row.price,
				pricePerM2: row.pricePerM2,
				areaM2: row.areaM2,
				plotAreaM2: row.plotAreaM2,
				rooms: row.rooms,
				floor: row.floor,
				floorCount: row.floorCount,
				buildYear: row.buildYear,
				buildingMaterial: row.buildingMaterial,
				condition: row.condition,
				ownership: row.ownership,
				heatingType: row.heatingType,
				buildingType: row.buildingType,
				plotType: row.plotType,
				market: row.market,
				hasBalcony: row.hasBalcony,
				hasTerrace: row.hasTerrace,
				hasGarden: row.hasGarden,
				hasElevator: row.hasElevator,
				hasParking: row.hasParking,
				hasGarage: row.hasGarage,
				hasBasement: row.hasBasement,
				auctionType: row.auctionType,
				lat: row.lat,
				lng: row.lng,
				parcelFeatures: row.parcelId
					? {
							areaM2: row.parcelAreaM2,
							frontageM: row.parcelFrontageM,
							roadDistanceM: row.parcelRoadDistanceM,
							roadClass: row.parcelRoadClass,
							buildingCoverage: row.parcelBuildingCoverage,
							landUseClass: row.parcelLandUseClass,
							zoningWz: row.parcelZoningWz,
							zoningNoPlan: row.parcelZoningNoPlan,
							zoningPlanCount: row.parcelZoningPlanCount,
							floodRisk: row.parcelFloodRisk,
							slopeDeg: row.parcelSlopeDeg,
							elevationM: row.parcelElevationM,
						}
					: null,
			};

			const score = scoreAlert(input, estimateResult.estimate, geo);
			await storeScore(row.id, score);
			scored++;
			bySegment[segment] = (bySegment[segment] ?? 0) + 1;
			byRegion[region] = (byRegion[region] ?? 0) + 1;
			if (score.eligible) eligible++;
		} catch (error) {
			errors.push(
				`listing ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	let alerts = 0;
	if (!options.dryRun) {
		alerts = await createAlerts(now);
	}

	return {
		startedAt: new Date(started).toISOString(),
		durationMs: Date.now() - started,
		scanned,
		scored,
		eligible,
		alerts,
		errors: errors.length,
		bySegment,
		byRegion,
		firstErrors: errors.slice(0, 10),
	};
}

async function storeScore(listingId: number, score: AlertScore): Promise<void> {
	const expiresAt = new Date(Date.now() + 14 * 86_400_000);
	await db
		.insert(listingScores)
		.values({
			listingId,
			scoreVersion: score.scoreVersion,
			segment: segmentLabel(score.segment),
			region: score.region,
			valueScore: score.valueScore,
			transitScore: score.transitScore,
			greenScore: score.greenScore,
			propertyScore: score.propertyScore,
			riskScore: score.riskScore,
			totalScore: score.totalScore,
			confidence: score.confidence,
			discountPct: score.discountPct,
			fairPrice: score.fairPrice,
			fairM2: score.fairM2,
			askingPrice: score.askingPrice,
			reasonsJson: JSON.stringify(score.reasons),
			amenitiesJson: JSON.stringify(score.amenities),
			flagsJson: JSON.stringify(score.flags),
			computedAt: new Date(),
			expiresAt,
		})
		.onConflictDoUpdate({
			target: [listingScores.listingId, listingScores.scoreVersion],
			set: {
				segment: score.segment,
				region: score.region,
				valueScore: score.valueScore,
				transitScore: score.transitScore,
				greenScore: score.greenScore,
				propertyScore: score.propertyScore,
				riskScore: score.riskScore,
				totalScore: score.totalScore,
				confidence: score.confidence,
				discountPct: score.discountPct,
				fairPrice: score.fairPrice,
				fairM2: score.fairM2,
				askingPrice: score.askingPrice,
				reasonsJson: JSON.stringify(score.reasons),
				amenitiesJson: JSON.stringify(score.amenities),
				flagsJson: JSON.stringify(score.flags),
				computedAt: new Date(),
				expiresAt,
			},
		});
}

/**
 * Rank eligible scores per region and segment and append today's top 5% to
 * the alert list. The pool is every scored, active offer (not only today's
 * arrivals), so a new offer competes against the full market; listings
 * already alerted on any earlier day are skipped, which makes the list grow
 * incrementally as new offers come in. Re-running is idempotent: the unique
 * alert index rejects duplicates.
 */
async function createAlerts(now: Date): Promise<number> {
	const day = dateOnly(now);
	const rows = await db
		.select({
			scoreId: listingScores.id,
			listingId: listingScores.listingId,
			segment: listingScores.segment,
			region: listingScores.region,
			totalScore: listingScores.totalScore,
			discountPct: listingScores.discountPct,
			confidence: listingScores.confidence,
			valueScore: listingScores.valueScore,
		})
		.from(listingScores)
		.innerJoin(listings, eq(listingScores.listingId, listings.id))
		.where(
			and(
				eq(listingScores.scoreVersion, SCORE_VERSION),
				eq(listings.isActive, true),
				eq(listings.isVisible, true),
				gte(listingScores.valueScore, ALERT_GATES.minValueScore),
				gte(listingScores.confidence, ALERT_GATES.minConfidence),
				gte(listingScores.discountPct, ALERT_GATES.minDiscountPct),
			),
		)
		.orderBy(desc(listingScores.totalScore));

	// Group the FULL eligible pool (including already-alerted listings) so
	// the 5% cut is stable across runs: a re-run without new offers inserts
	// nothing, and a new offer only enters when it out-ranks the current
	// top 5%. Skipping alerted rows before the cut would append another 5%
	// of the remainder on every run.
	const groups = new Map<string, typeof rows>();
	const alerted = new Set(
		(
			await db
				.select({ listingId: listingAlerts.listingId })
				.from(listingAlerts)
		).map((row) => row.listingId),
	);
	for (const row of rows) {
		const key = `${row.region}:${row.segment}`;
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}

	let inserted = 0;
	for (const group of groups.values()) {
		const topN = Math.max(1, Math.ceil(group.length * 0.05));
		for (let index = 0; index < Math.min(topN, group.length); index++) {
			const row = group[index];
			if (!row || alerted.has(row.listingId)) continue;
			const result = await db
				.insert(listingAlerts)
				.values({
					listingId: row.listingId,
					scoreId: row.scoreId,
					alertDate: day,
					segment: row.segment,
					region: row.region,
					rank: index + 1,
					score: row.totalScore,
					channel: "in_app",
					status: "pending",
					payloadJson: JSON.stringify({
						discountPct: row.discountPct,
						confidence: row.confidence,
					}),
				})
				.onConflictDoNothing({
					target: [
						listingAlerts.listingId,
						listingAlerts.alertDate,
						listingAlerts.channel,
					],
				})
				.returning({ id: listingAlerts.id });
			if (result.length > 0) inserted++;
		}
	}
	return inserted;
}
