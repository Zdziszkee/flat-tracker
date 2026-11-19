/**
 * Alert scoring run.
 *
 * Reads active sale listings, computes a transparent score, stores the
 * component breakdown, ranks within region and segment, and appends new
 * top-5% offers to today's in-app alert list. Runs incrementally after every
 * refresh (only listings without a current-version score are scored) and as
 * a daily task; a listing is alerted at most once.
 */

import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";

import { db } from "#/db/index";
import { regionOf, type TrackedRegion } from "#/db/region";
import {
	listingAlerts,
	listingScores,
	listings,
	parcelFeatures,
} from "#/db/schema";
import { loadScoredFacts, type ScoredFacts } from "#/lib/llm/fact-access";
import { propertyKindOf } from "#/lib/property-kind";
import {
	type AlertScore,
	type ScoreListingInput,
	scoreAlert,
} from "#/lib/scoring/alert-score";
import {
	ALERT_FRESHNESS,
	ALERT_GATES,
	ALERT_MAX_PER_INVESTMENT,
	ALERT_TOP_OFFERS,
	type AlertSegment,
	freshArrivalRank,
	SCORE_VERSION,
	shouldAlertFreshArrival,
} from "#/lib/scoring/config";
import { neighbourhoodAt, strMarketAt } from "#/lib/scoring/house-nature";
import {
	clearPlaceholderCache,
	isPlaceholderListing,
	loadPlaceholderPoints,
	type PlaceholderIndex,
} from "#/lib/scoring/placeholder-points";
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
	/**
	 * Restrict the run to these listings. Used to backfill scores that were
	 * stored before a field existed (for example the comparable counts on
	 * the alert cards) without re-running the whole pool.
	 */
	listingIds?: readonly number[];
	/** Compute and store scores but do not create alerts. */
	dryRun?: boolean;
	now?: Date;
	/**
	 * Called every few dozen offers with the running counters. The refresh
	 * child forwards this to /api/crawl-status, so the /sources page can show
	 * how many offers the scoring phase has worked through.
	 */
	onProgress?: (progress: {
		done: number;
		total: number;
		scored: number;
		errors: number;
	}) => void;
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

/**
 * Shared row shape for every scoring entry point. `parcelFeatures` is
 * optional: it feeds plot scoring and is joined only when a parcel exists.
 */
const SCORE_ROW_COLUMNS = {
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
	// The portal attribute blob carries the heating as a short code
	// ("urban", "gas") on detail-crawled rows; `json_valid` keeps a
	// malformed blob from aborting the whole scoring query.
	featuresHeating: sql<
		string | null
	>`case when json_valid(${listings.features}) then json_extract(${listings.features}, '$.heating') end`.as(
		"features_heating",
	),
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
	street: listings.street,
	voivodeship: listings.voivodeship,
	buildingId: listings.buildingId,
	investmentId: listings.investmentId,
	district: listings.district,
	propertyKind: listings.propertyKind,
	propertyType: listings.propertyType,
	externalId: listings.externalId,
	firstSeenAt: listings.firstSeenAt,
	parcelId: listings.parcelId,
	parcelAreaM2: parcelFeatures.areaM2,
	parcelFrontageM: parcelFeatures.frontageM,
	parcelRoadDistanceM: parcelFeatures.roadDistanceM,
	parcelRoadClass: parcelFeatures.roadClass,
	parcelBuildingCoverage: parcelFeatures.buildingCoverage,
	parcelBuildingCount: parcelFeatures.buildingCount,
	parcelLandUseClass: parcelFeatures.landUseClass,
	parcelZoningWz: parcelFeatures.zoningWz,
	parcelZoningNoPlan: parcelFeatures.zoningNoPlan,
	parcelZoningPlanCount: parcelFeatures.zoningPlanCount,
	parcelFloodRisk: parcelFeatures.floodRisk,
	parcelSlopeDeg: parcelFeatures.slopeDeg,
	parcelElevationM: parcelFeatures.elevationM,
} as const;

/**
 * Base eligibility for scoring: a sale, an active row, a visible row, a
 * price, area and unit price, and a portal status that is not terminal. The
 * derived kind when the listing-derived pass has run, the raw portal type
 * otherwise: scoring must not silently skip a fresh DB whose derived columns
 * have not been recomputed yet.
 */
function baseScoreFilters(): SQL[] {
	return [
		eq(listings.offerType, "sale"),
		eq(listings.isActive, true),
		eq(listings.isVisible, true),
		or(isNotNull(listings.propertyKind), isNotNull(listings.propertyType)) ??
			sql`1 = 1`,
		isNotNull(listings.price),
		isNotNull(listings.areaM2),
		isNotNull(listings.pricePerM2),
		sql`${listings.price} > 0`,
		sql`${listings.areaM2} > 0`,
		sql`${listings.pricePerM2} > 0`,
		sql`coalesce(${listings.portalStatus}, '') not in ('sold', 'reserved', 'expired')`,
	];
}

/**
 * Only offers without a current-version score. The subquery rides the
 * (listing_id, score_version) unique index.
 */
function missingCurrentScoreFilter(): SQL {
	return sql`not exists (select 1 from ${listingScores} where ${listingScores.listingId} = ${listings.id} and ${listingScores.scoreVersion} = ${SCORE_VERSION})`;
}

async function loadScoreRows(filters: SQL[], limit?: number) {
	let query = db
		.select(SCORE_ROW_COLUMNS)
		.from(listings)
		.leftJoin(parcelFeatures, eq(listings.parcelId, parcelFeatures.parcelId))
		.where(and(...filters))
		.orderBy(desc(listings.firstSeenAt));
	if (limit != null && limit > 0) {
		query = query.limit(limit) as typeof query;
	}
	return query;
}

type ScoreRow = Awaited<ReturnType<typeof loadScoreRows>>[number];

interface ScoredListing {
	id: number;
	scoreId: number;
	score: AlertScore;
	segment: AlertSegment;
	region: TrackedRegion;
}

/**
 * Score and store one listing row. Returns null when the row has no usable
 * kind, segment or region (nothing to score: not an error). Throws on a
 * storage/estimate failure so the caller attributes it to the listing.
 */
async function scoreListingRow(
	row: ScoreRow,
	now: Date,
	facts: Map<number, ScoredFacts>,
	placeholders: PlaceholderIndex,
): Promise<ScoredListing | null> {
	const kind = propertyKindOf({
		source: row.source,
		title: row.title,
		propertyType: row.propertyKind ?? row.propertyType,
		// Without the id an investmap `inv-` investment stand-in classifies as
		// a flat (the feed-semantics fallback) and gets a fiction score.
		externalId: row.externalId,
	});
	if (!kind) return null;
	const segment = SEGMENT_BY_KIND[kind];
	if (!segment) return null;
	const region =
		normalizeRegion(row.voivodeship) ??
		(row.lat != null && row.lng != null ? regionOf(row.lat, row.lng) : null);
	if (!region) return null;

	const baseGeo =
		row.lat != null && row.lng != null
			? await geoUniqueness(row.lat, row.lng)
			: null;
	// A house is scored on its solitude and its rental market, both read from
	// the DB and carried in the stored amenities blob so the card can show
	// them. Land reads only the rental market: a dense airbnb/booking cluster
	// is the evidence that a holiday plot in this area can earn.
	const neighbourhood =
		segment === "house" ? await neighbourhoodAt(row.lat, row.lng) : null;
	const str =
		segment === "house" || segment === "plot"
			? await strMarketAt(row.lat, row.lng)
			: null;
	const geo =
		baseGeo == null
			? null
			: {
					...baseGeo,
					neighbourM: neighbourhood?.nearestBuildingM ?? null,
					neighbours150m: neighbourhood?.buildingsWithin150m ?? null,
					strNightly: str?.nightlyMedian ?? null,
					strSample: str?.sampleCount ?? null,
					strOffers: str?.offersWithin2km ?? null,
				};

	const rowFacts = facts.get(row.id) ?? null;
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
			// Quality/condition inputs. The estimate applies the facts to its
			// median (a "do remontu" tenement is valued below a renovated one)
			// and records the correction with the score.
			facts: rowFacts,
			buildYear: row.buildYear,
			buildingType: row.buildingType,
			buildingMaterial: row.buildingMaterial,
			condition: row.condition,
			hasElevator: row.hasElevator,
			floor: row.floor,
			floorCount: row.floorCount,
			landUseClass: row.parcelLandUseClass,
			zoningWz: row.parcelZoningWz,
			zoningPlanCount: row.parcelZoningPlanCount,
			roadDistanceM: row.parcelRoadDistanceM,
			slopeDeg: row.parcelSlopeDeg,
			floodRisk: row.parcelFloodRisk,
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
		facts: rowFacts,
		neighbours: neighbourhood,
		str,
		placeholderCoordinates: isPlaceholderListing(placeholders, {
			id: row.id,
			lat: row.lat,
			lng: row.lng,
			city: row.city,
			street: row.street,
			buildingId: row.buildingId,
			investmentId: row.investmentId,
		}),
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
		featuresHeating: row.featuresHeating,
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
					buildingCount: row.parcelBuildingCount,
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
	const scoreId = await storeScore(row.id, score);
	return { id: row.id, scoreId, score, segment, region };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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
	// A crawl that ran since the last call may have added the listings that
	// make a point a placeholder, or removed them by pruning.
	clearPlaceholderCache();
	const now = options.now ?? new Date();
	const days = options.days ?? 7;
	const cutoff = new Date(now.getTime() - days * 86_400_000);
	const errors: string[] = [];
	const bySegment: Record<string, number> = {};
	const byRegion: Record<string, number> = {};
	let scanned = 0;
	let scored = 0;
	let eligible = 0;

	const filters = baseScoreFilters();
	if (!options.all && !options.incremental && !options.listingIds?.length) {
		filters.push(
			sql`coalesce(${listings.firstSeenAt}, ${listings.listedAt}, ${listings.scrapedAt}) >= ${Math.floor(cutoff.getTime() / 1000)}`,
		);
	}
	if (options.incremental) {
		filters.push(missingCurrentScoreFilter());
	}
	if (options.listingIds?.length) {
		filters.push(inArray(listings.id, [...new Set(options.listingIds)]));
	}

	const rows = await loadScoreRows(filters, options.limit);
	scanned = rows.length;
	// One chunked read for the whole batch: the score needs the facts the
	// extractor read out of every description (heating, building style,
	// tenement age, plot zoning, utilities).
	const facts = await loadScoredFacts(rows.map((row) => row.id));
	const placeholders = await loadPlaceholderPoints();

	let done = 0;
	for (const row of rows) {
		try {
			const entry = await scoreListingRow(row, now, facts, placeholders);
			if (entry) {
				scored++;
				bySegment[entry.segment] = (bySegment[entry.segment] ?? 0) + 1;
				byRegion[entry.region] = (byRegion[entry.region] ?? 0) + 1;
				if (entry.score.eligible) eligible++;
			}
		} catch (error) {
			errors.push(`listing ${row.id}: ${errorMessage(error)}`);
		}
		done++;
		// A progress report per offer would rewrite a JSON file ~10x a second;
		// one every 25 keeps the feed live without the I/O.
		if (options.onProgress && done % 25 === 0) {
			options.onProgress({
				done,
				total: rows.length,
				scored,
				errors: errors.length,
			});
		}
	}
	options.onProgress?.({
		done: rows.length,
		total: rows.length,
		scored,
		errors: errors.length,
	});

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

export interface ArrivalScoreSummary {
	/** Listings scored by this call. */
	scored: number;
	/** Fresh-arrival alerts inserted into today's list. */
	alerts: number;
	/** Today's leaderboard was rebuilt by this call (debounced). */
	rebuilt: boolean;
	/** Per-listing or batch failures, already collected for the caller. */
	errors: string[];
}

/**
 * Shortest gap between two leaderboard rebuilds while a crawl is running.
 *
 * The list is the day's top 25 per segment, so it has to move when offers
 * arrive, not only at the end of a refresh. Rebuilding it is one ranked query
 * plus up to 75 row writes, which is cheap but not free: a site can deliver
 * hundreds of new offers in a burst, so bursts are coalesced into one rebuild
 * per interval instead of one per batch.
 */
export const ALERT_REBUILD_MIN_INTERVAL_MS = 15_000;

/** Whether a rebuild is due, given the last one and the current clock. */
export function shouldRebuildAlerts(
	nowMs: number,
	lastRebuildMs: number,
): boolean {
	return nowMs - lastRebuildMs >= ALERT_REBUILD_MIN_INTERVAL_MS;
}

let lastAlertRebuildMs = 0;

/**
 * Score the offers a crawl just saved and alert the ones that beat their
 * 24-hour cohort.
 *
 * The cohort is every current-version scored offer in the same region and
 * segment whose `coalesce(firstSeenAt, listedAt, scrapedAt)` falls inside
 * the last `ALERT_FRESHNESS.windowHours` hours; the new offer is part of it
 * because its score is stored before the cohort is read, so it competes
 * with the peers that arrived before it. An offer alerts when its score sits
 * inside the cohort's top `ALERT_FRESHNESS.topPercent`, i.e. it beats at
 * least 95% of the offers seen in the previous day.
 *
 * This is an addition to the full-pool top-5% rule, not a replacement: the
 * refresh's scoring phase still ranks the whole market and can alert a fresh
 * offer that missed its cohort, and a fresh alert never removes anything
 * from that list.
 *
 * Never throws: one bad listing (or a failed batch read) lands in `errors`,
 * so a crawl is never aborted by scoring. Idempotent: the unique
 * (listing_id, alert_date, channel) index makes a re-run insert nothing.
 */
export async function scoreArrivals(
	listingIds: readonly number[],
	now: Date = new Date(),
): Promise<ArrivalScoreSummary> {
	const summary: ArrivalScoreSummary = {
		scored: 0,
		alerts: 0,
		rebuilt: false,
		errors: [],
	};
	const ids = [...new Set(listingIds)].filter(
		(id) => Number.isInteger(id) && id > 0,
	);
	if (ids.length === 0) return summary;
	// The crawl that produced these ids may have just created a shared
	// placeholder point, so the cached set must not be reused here.
	clearPlaceholderCache();

	const day = dateOnly(now);
	const windowStart = new Date(
		now.getTime() - ALERT_FRESHNESS.windowHours * 3_600_000,
	);
	try {
		const rows = await loadScoreRows([
			...baseScoreFilters(),
			inArray(listings.id, ids),
			missingCurrentScoreFilter(),
		]);
		const facts = await loadScoredFacts(rows.map((row) => row.id));
		const placeholders = await loadPlaceholderPoints();
		const scoredEntries: ScoredListing[] = [];
		for (const row of rows) {
			try {
				const entry = await scoreListingRow(row, now, facts, placeholders);
				if (!entry) continue;
				summary.scored++;
				scoredEntries.push(entry);
			} catch (error) {
				summary.errors.push(`listing ${row.id}: ${errorMessage(error)}`);
			}
		}
		// The new scores are stored, so the day's leaderboard can be rebuilt
		// right away: /alerts then shows the arrivals without waiting for the
		// end of the refresh. Rebuilt BEFORE the fresh-arrival appends, because
		// a rebuild replaces the day's cut and would drop them.
		if (
			scoredEntries.length > 0 &&
			shouldRebuildAlerts(Date.now(), lastAlertRebuildMs)
		) {
			lastAlertRebuildMs = Date.now();
			const failure = await rebuildTodayAlerts(now).catch(
				(error: unknown) => error,
			);
			if (failure instanceof Error) {
				summary.errors.push(`leaderboard: ${errorMessage(failure)}`);
			} else {
				summary.rebuilt = true;
			}
		}
		// ALERT_GATES live inside the score: an ineligible offer is stored but
		// never competes for an alert.
		for (const entry of scoredEntries) {
			if (!entry.score.eligible) continue;
			try {
				if (await alertFreshArrival(entry, windowStart, now, day)) {
					summary.alerts++;
				}
			} catch (error) {
				summary.errors.push(`alert ${entry.id}: ${errorMessage(error)}`);
			}
		}
	} catch (error) {
		summary.errors.push(`arrival batch: ${errorMessage(error)}`);
	}
	return summary;
}

/**
 * Append today's fresh-arrival alert when the offer is inside the cohort's
 * top cut. `rank` is 1 + the count of strictly higher cohort scores, the
 * same meaning it has in the full-pool rule, so /alerts can read it
 * unchanged.
 */
/**
 * True while today's list holds fewer than `ALERT_MAX_PER_INVESTMENT` units of
 * the arriving offer's investment. Offers without an investment key (no id, no
 * announced title, no street) are always allowed: there is nothing to group.
 */
async function underInvestmentCap(entry: ScoredListing): Promise<boolean> {
	const [listing] = await db
		.select({
			city: listings.city,
			street: listings.street,
			investmentId: listings.investmentId,
			investmentTitle: listings.investmentTitle,
		})
		.from(listings)
		.where(eq(listings.id, entry.id))
		.limit(1);
	if (!listing) return false;
	const key = investmentKey(listing);
	if (key == null) return true;
	const todayRows = await db
		.select({
			city: listings.city,
			street: listings.street,
			investmentId: listings.investmentId,
			investmentTitle: listings.investmentTitle,
		})
		.from(listingAlerts)
		.innerJoin(listings, eq(listingAlerts.listingId, listings.id))
		.where(
			and(
				eq(listingAlerts.alertDate, sql`date('now')`),
				eq(listingAlerts.segment, entry.segment),
			),
		);
	let count = 0;
	for (const row of todayRows) if (investmentKey(row) === key) count++;
	return count < ALERT_MAX_PER_INVESTMENT;
}

async function alertFreshArrival(
	entry: ScoredListing,
	windowStart: Date,
	now: Date,
	day: string,
): Promise<boolean> {
	const seenAt = sql`coalesce(${listings.firstSeenAt}, ${listings.listedAt}, ${listings.scrapedAt})`;
	const cohort = await db
		.select({ totalScore: listingScores.totalScore })
		.from(listingScores)
		.innerJoin(listings, eq(listingScores.listingId, listings.id))
		.where(
			and(
				eq(listingScores.scoreVersion, SCORE_VERSION),
				eq(listingScores.segment, entry.segment),
				eq(listingScores.region, entry.region),
				eq(listingScores.eligible, true),
				eq(listings.isActive, true),
				eq(listings.isVisible, true),
				sql`${seenAt} >= ${Math.floor(windowStart.getTime() / 1000)}`,
				sql`${seenAt} <= ${Math.ceil(now.getTime() / 1000)}`,
			),
		);
	const cohortScores = cohort.map((row) => row.totalScore);
	if (!shouldAlertFreshArrival(entry.score.totalScore, cohortScores)) {
		return false;
	}

	// The leaderboard caps how many units of one investment it shows, and a
	// fresh arrival must respect the same promise: a developer releasing ten
	// units in one morning would otherwise fill today's list through this path
	// alone.
	if (!(await underInvestmentCap(entry))) return false;

	const inserted = await db
		.insert(listingAlerts)
		.values({
			listingId: entry.id,
			scoreId: entry.scoreId,
			alertDate: day,
			segment: entry.segment,
			region: entry.region,
			rank: freshArrivalRank(entry.score.totalScore, cohortScores),
			score: entry.score.totalScore,
			channel: "in_app",
			status: "pending",
			payloadJson: JSON.stringify({
				reason: "fresh_arrival",
				cohortSize: cohortScores.length,
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
	return inserted.length > 0;
}

async function storeScore(
	listingId: number,
	score: AlertScore,
): Promise<number> {
	const expiresAt = new Date(Date.now() + 14 * 86_400_000);
	const stored = await db
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
			eligible: score.eligible,
			fallbackEligible: score.fallbackEligible,
			gateReason: score.gateReason,
			gateFailuresJson: JSON.stringify(score.gateFailures),
			discountPct: score.discountPct,
			fairPrice: score.fairPrice,
			fairM2: score.fairM2,
			askingPrice: score.askingPrice,
			compCount: score.compCount,
			compRcnCount: score.compRcnCount,
			reasonsJson: JSON.stringify(score.reasons),
			amenitiesJson: JSON.stringify(score.amenities),
			flagsJson: JSON.stringify(score.flags),
			valuationJson: JSON.stringify(score.valuation ?? {}),
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
				eligible: score.eligible,
				fallbackEligible: score.fallbackEligible,
				gateReason: score.gateReason,
				gateFailuresJson: JSON.stringify(score.gateFailures),
				discountPct: score.discountPct,
				fairPrice: score.fairPrice,
				fairM2: score.fairM2,
				askingPrice: score.askingPrice,
				compCount: score.compCount,
				compRcnCount: score.compRcnCount,
				reasonsJson: JSON.stringify(score.reasons),
				amenitiesJson: JSON.stringify(score.amenities),
				flagsJson: JSON.stringify(score.flags),
				valuationJson: JSON.stringify(score.valuation ?? {}),
				computedAt: new Date(),
				expiresAt,
			},
		})
		.returning({ id: listingScores.id });
	const row = stored[0];
	if (!row) {
		throw new Error(`score upsert returned no row for listing ${listingId}`);
	}
	// A re-score updates the same (listing, version) row, so any alert that
	// already points at it must mirror the new values; otherwise a historical
	// alert would claim a score the stored row no longer has.
	await db
		.update(listingAlerts)
		.set({
			score: score.totalScore,
			segment: segmentLabel(score.segment),
			region: score.region,
		})
		.where(eq(listingAlerts.scoreId, row.id));
	return row.id;
}

/**
 * Rebuild today's leaderboard from the current-version pool. Used after a
 * manual re-score (a version bump) so the page shows the new scores today
 * instead of waiting for the next refresh.
 */
export async function rebuildTodayAlerts(
	now: Date = new Date(),
): Promise<number> {
	return createAlerts(now);
}

/**
 * Normalize a street for duplicate detection: "ul. Jana Sobieskiego" and
 * "Jana Sobieskiego" are the same offer.
 */
function streetKey(street: string | null): string {
	return (street ?? "")
		.toLowerCase()
		.replace(/\bul\.?\s+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The same physical offer, as two portals publish it: same city, same street
 * (when known), same area within a square metre and the same asking price
 * within 1%. Today's list carried "Sobieskiego 56 m² 929 000" twice, the
 * Bielsko-Biała 140 m² house twice and a Janczowa plot twice (morizon and
 * gratka share one feed), which halves the value of a 25-slot list.
 */
export function duplicateKey(row: {
	city: string | null;
	street: string | null;
	areaM2: number | null;
	price: number | null;
}): string | null {
	if (row.areaM2 == null || row.price == null || row.price <= 0) return null;
	const area = Math.round(row.areaM2);
	// 1% of the price, so a portal that rounds to the nearest 1000 zł still
	// matches. A null street falls back to the city plus area and price, which
	// is enough for a village plot published by two feeds.
	const priceBand = Math.round(row.price / Math.max(1000, row.price * 0.01));
	return [
		(row.city ?? "").toLowerCase(),
		streetKey(row.street),
		area,
		priceBand,
	].join("|");
}

/**
 * Which investment a row belongs to, for the per-investment cap: an identified
 * investment id, else the announced investment title, else the street.
 */
export function investmentKey(row: {
	city: string | null;
	street: string | null;
	investmentId: string | null;
	investmentTitle: string | null;
}): string | null {
	if (row.investmentId) return `id:${row.investmentId}`;
	const title = row.investmentTitle?.trim().toLowerCase();
	if (title) return `title:${title}`;
	const street = streetKey(row.street);
	if (street) return `street:${row.city?.toLowerCase() ?? ""}:${street}`;
	return null;
}

/**
 * Take the best `ALERT_TOP_OFFERS` rows of one segment, skipping near-duplicate
 * offers and capping how many units of one investment may fill the list.
 *
 * The pool is already ranked (eligible first, then score), so the first row of
 * a duplicate or investment group is the one worth showing. A segment doesn't
 * stop at the cap: the next distinct offers take the freed slots, which keeps
 * the list at 25 as long as the pool allows it. Selection only, never a score.
 */
export function selectLeaders<
	T extends Parameters<typeof duplicateKey>[0] &
		Parameters<typeof investmentKey>[0],
>(group: readonly T[]): T[] {
	const leaders: T[] = [];
	const seenDuplicates = new Set<string>();
	const perInvestment = new Map<string, number>();
	for (const row of group) {
		if (leaders.length >= ALERT_TOP_OFFERS) break;
		const dup = duplicateKey(row);
		if (dup != null && seenDuplicates.has(dup)) continue;
		const investment = investmentKey(row);
		if (investment != null) {
			const used = perInvestment.get(investment) ?? 0;
			if (used >= ALERT_MAX_PER_INVESTMENT) continue;
			perInvestment.set(investment, used + 1);
		}
		if (dup != null) seenDuplicates.add(dup);
		leaders.push(row);
	}
	return leaders;
}

/**
 * Rank eligible scores per segment and replace today's list with the top
 * `ALERT_TOP_OFFERS`. The pool is every scored, active offer (not only
 * today's arrivals), so a new offer competes against the full market.
 * Re-running is idempotent through the unique
 * `(listing, alert_date, channel)` index.
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
			eligible: listingScores.eligible,
			// Selection-time grouping: the same offer often arrives twice from
			// two portals, and one investment can publish a whole price list.
			city: listings.city,
			street: listings.street,
			areaM2: listings.areaM2,
			price: listings.price,
			investmentId: listings.investmentId,
			investmentTitle: listings.investmentTitle,
		})
		.from(listingScores)
		.innerJoin(listings, eq(listingScores.listingId, listings.id))
		.where(
			and(
				eq(listingScores.scoreVersion, SCORE_VERSION),
				// A fully eligible offer always outranks a fallback one, whatever
				// the score says (see the orderBy below).
				or(
					eq(listingScores.eligible, true),
					eq(listingScores.fallbackEligible, true),
				),
				eq(listings.isActive, true),
				eq(listings.isVisible, true),
				gte(listingScores.valueScore, ALERT_GATES.minValueScore),
				gte(listingScores.confidence, ALERT_GATES.minConfidence),
				gte(listingScores.discountPct, ALERT_GATES.minDiscountPct),
			),
		)
		.orderBy(desc(listingScores.eligible), desc(listingScores.totalScore));

	// Group the FULL eligible pool, then keep the best `ALERT_TOP_OFFERS` per
	// segment (flats, houses, plots across both regions). The group is the
	// segment alone.
	const groups = new Map<string, typeof rows>();
	for (const row of rows) {
		const key = row.segment;
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}

	// Today's list is a leaderboard, not an append-only inbox: replace it with
	// the current cut, so a better offer that appeared during the day is shown
	// and an offer that lost its place disappears. Older dates stay untouched.
	const dayLeaders: Array<(typeof rows)[number]> = [];
	for (const group of groups.values()) {
		for (const row of selectLeaders(group)) dayLeaders.push(row);
	}
	const leaderIds = dayLeaders.map((row) => row.listingId);
	if (leaderIds.length > 0) {
		await db
			.delete(listingAlerts)
			.where(
				and(
					eq(listingAlerts.alertDate, day),
					notInArray(listingAlerts.listingId, leaderIds),
				),
			);
	} else {
		await db.delete(listingAlerts).where(eq(listingAlerts.alertDate, day));
	}

	let inserted = 0;
	const rankBySegment = new Map<string, number>();
	for (const row of dayLeaders) {
		const rank = (rankBySegment.get(row.segment) ?? 0) + 1;
		rankBySegment.set(row.segment, rank);
		const result = await db
			.insert(listingAlerts)
			.values({
				listingId: row.listingId,
				scoreId: row.scoreId,
				alertDate: day,
				segment: row.segment,
				region: row.region,
				rank,
				score: row.totalScore,
				channel: "in_app",
				status: "pending",
				payloadJson: JSON.stringify({
					cut: `top${ALERT_TOP_OFFERS}`,
					discountPct: row.discountPct,
					confidence: row.confidence,
					// Set for the offers that fill a short section: every gate
					// passed except proof of municipal heating.
					heatingUnknown: !row.eligible,
				}),
			})
			.onConflictDoUpdate({
				target: [
					listingAlerts.listingId,
					listingAlerts.alertDate,
					listingAlerts.channel,
				],
				// Keep the original createdAt (the freshness badge) and any
				// fresh-arrival payload; only the leaderboard facts move.
				set: {
					scoreId: row.scoreId,
					segment: row.segment,
					region: row.region,
					rank,
					score: row.totalScore,
				},
			})
			.returning({ id: listingAlerts.id });
		if (result.length > 0) inserted++;
	}
	return inserted;
}
