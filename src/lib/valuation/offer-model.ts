import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { HIDDEN_SOURCES } from "#/crawler/hidden-sources";
import { db } from "#/db/index";
import { priceIndexSeries } from "#/db/queries/price-indices";
import { regionOf } from "#/db/region";
import { listings, parcelMeta, parcels, transactions } from "#/db/schema";
import type { ScoredFacts } from "#/lib/llm/fact-access";
import { propertyKindOf } from "#/lib/property-kind";
import type { AskingRatio } from "#/lib/valuation/asking-ratio";
import { askingToTransactionRatio } from "#/lib/valuation/asking-ratio";
import { AREA_ELASTICITY, convertCompPrice } from "#/lib/valuation/comp-price";
import {
	type CompSelection,
	type CompTarget,
	estimateCompPrice,
	GUARDED_FACTOR_WEIGHT,
	guardTimeFactor,
	implausibleDiscount,
	type PlotClassFamily,
	PRICE_METRIC,
	plotClassFamily,
	plotClassFamilyFromType,
	type SelectionOptions,
	selectComparables,
	selectionDefaults,
} from "#/lib/valuation/comp-selection";
import { estimateStatistics } from "#/lib/valuation/estimate-statistics";
import { externalCityFor } from "#/lib/valuation/external-city";
import {
	currentQuarter,
	grid10Key,
	type IndexPoint,
	type ValuationSegment as IndexSegment,
	normalizeDistrict,
	quarterOf,
	timeAdjustment,
	weightedQuantile,
} from "#/lib/valuation/price-index";
import { qualityAdjustment } from "#/lib/valuation/quality-factor";
import type {
	ValuationComparable,
	ValuationCompSet,
	ValuationConfidenceLevel,
	ValuationEstimate,
	ValuationSegment,
} from "#/types/listing";
import { upsidePotential } from "./upside";

/** Input required by the sales-comparison model. */
export interface OfferForValuation {
	id: number;
	source: string;
	externalId: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	district: string | null;
	lat: number | null;
	lng: number | null;
	buildingId: number | null;
	market: string | null;
	plotType: string | null;
	kind: ValuationSegment;
	/** Physical facts used by the condition/quality correction. */
	facts?: ScoredFacts | null;
	buildYear?: number | null;
	buildingType?: string | null;
	buildingMaterial?: string | null;
	condition?: string | null;
	hasElevator?: boolean | null;
	floor?: string | null;
	floorCount?: number | null;
	landUseClass?: string | null;
	zoningWz?: boolean | null;
	zoningPlanCount?: number | null;
	roadDistanceM?: number | null;
	slopeDeg?: number | null;
	floodRisk?: boolean | null;
}

interface RcnRow {
	transactionId: string;
	date: Date | number;
	price: number;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
	district: string | null;
	street: string | null;
	streetNumber: string | null;
	market: number | null;
	lat: number | null;
	lng: number | null;
	region: string | null;
	buildingId: number | null;
	parcelId: string | null;
}

interface ListingRow {
	id: number;
	source: string;
	externalId: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	district: string | null;
	address: string | null;
	lat: number | null;
	lng: number | null;
	listedAt: Date | null;
	firstSeenAt: Date | null;
	propertyType: string | null;
	market: string | null;
	buildingId: number | null;
	plotType: string | null;
	floor: string | null;
}

type CompSet = "buildingRcn" | "nearbyRcn" | "listing";

interface WorkingComp {
	id: string;
	source: "rcn" | "listing";
	set: CompSet;
	kind: ValuationSegment;
	date: Date | number | null;
	price: number | null;
	pricePerM2: number;
	areaM2: number;
	rooms: number | null;
	district: string | null;
	address: string | null;
	lat: number | null;
	lng: number | null;
	region: string | null;
	market: number | null;
	distanceM: number | null;
	timeFactor: number;
	/** Size correction `(compArea / targetArea) ** beta`. */
	sizeFactor: number;
	adjustedPriceM2: number;
	weight: number;
	floor: string | null;
	/** Plot land-use family, when the cadastre knows it. */
	plotClassFamily: PlotClassFamily | null;
	indexSource: string | null;
	/** Asking-to-transaction ratio applied to a listing comp. */
	askingRatio: number | null;
	indexGeography: string | null;
	indexFromPeriod: string | null;
	indexToPeriod: string | null;
	indexSegment: string | null;
}

const AUCTION_SOURCES = new Set(["licytacje-komornik", "mapalicytacji"]);
const FIVE_YEARS_SECONDS = 5 * 365 * 86_400;

export interface MarketMedian {
	/** Median transaction price per m² for the offer's kind and city. */
	medianM2: number;
	p25M2: number;
	p75M2: number;
	/** Transactions behind the median. */
	sample: number;
	/** Radius the median was measured in (null for a region-wide sample). */
	radiusM: number | null;
	/** How far back the sample reaches. */
	months: number;
}

export interface SaleValuationResult {
	estimate: ValuationEstimate | null;
	reason: string | null;
	/**
	 * City-wide RCN median, measured independently of the comp selection: a
	 * reference for a thin comp set ("here is the whole market") rather than a
	 * substitute for comparables.
	 */
	marketMedian?: MarketMedian | null;
}

function secondsOf(value: Date | number | null): number | null {
	if (value == null) return null;
	return value instanceof Date ? value.getTime() / 1000 : value;
}

function isoOf(value: Date | number | null): string | null {
	const seconds = secondsOf(value);
	return seconds == null ? null : new Date(seconds * 1000).toISOString();
}

export function haversineM(
	lat1: number,
	lng1: number,
	lat2: number,
	lng2: number,
): number {
	const rad = Math.PI / 180;
	const dLat = (lat2 - lat1) * rad;
	const dLng = (lng2 - lng1) * rad;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function bbox(lat: number, lng: number, meters: number) {
	const dLat = meters / 111_320;
	const dLng = meters / (111_320 * Math.cos((lat * Math.PI) / 180));
	return {
		minLat: lat - dLat,
		maxLat: lat + dLat,
		minLng: lng - dLng,
		maxLng: lng + dLng,
	};
}

function requiredKind(kind: ValuationSegment): "unit" | "building" | "parcel" {
	return kind === "flat" ? "unit" : kind === "house" ? "building" : "parcel";
}

function validM2(kind: ValuationSegment): [number, number] {
	if (kind === "flat") return [500, 60000];
	if (kind === "house") return [100, 40000];
	return [0.01, 20000];
}

/**
 * Query radius for comparable candidates, from the segment policy
 * (`RADII_BY_KIND`). Flats and plots query 1 km; houses query 20 km because
 * rural houses are too sparse for a one-kilometre comp set. A wider candidate
 * box only costs rows the selection already knows how to rank and cap.
 */
function initialRadius(kind: ValuationSegment): number {
	return selectionDefaults(kind).radiiM[0] ?? 1000;
}

function offerMarket(offer: OfferForValuation): 1 | 2 | null {
	const market = offer.market?.toLowerCase() ?? "";
	if (market === "primary" || market === "pierwotny") return 1;
	if (market === "secondary" || market === "wtórny") return 2;
	return null;
}

function indexSegmentFor(row: {
	kind: ValuationSegment;
	market: number | null;
}): IndexSegment {
	if (row.kind === "flat") {
		if (row.market === 1) return "flat_primary";
		if (row.market === 2) return "flat_secondary";
		return "flat";
	}
	return row.kind;
}

/**
 * Plots must prove their land-use family on both sides before they can share
 * a comp set: a village building plot priced against agricultural or forest
 * land is exactly the "94% below market" failure the live list showed.
 */
const REQUIRE_PLOT_TYPE_AGREEMENT = true;

/** The offer's land-use family, from EGiB or from the advert text. */
function offerPlotFamily(offer: OfferForValuation): PlotClassFamily | null {
	if (offer.kind !== "plot") return null;
	return (
		plotClassFamily(offer.landUseClass) ??
		plotClassFamilyFromType(offer.plotType) ??
		null
	);
}

function compTargetFor(
	offer: OfferForValuation,
	nowSeconds: number,
): CompTarget {
	return {
		kind: offer.kind,
		areaM2: offer.areaM2 as number,
		rooms: offer.rooms,
		market: offerMarket(offer),
		asOfSeconds: nowSeconds,
		plotClassFamily: offerPlotFamily(offer),
		floor: offer.floor ?? null,
	};
}

function selectionOptionsFor(kind: ValuationSegment): SelectionOptions {
	return {
		...selectionDefaults(kind),
		requirePlotTypeAgreement: kind === "plot" && REQUIRE_PLOT_TYPE_AGREEMENT,
	};
}

/** Selected comps in selection order (weight descending). */
function selectedComps<T extends WorkingComp>(
	selection: CompSelection<T>,
): T[] {
	// The selection owns the weight; copy it onto the working comp the rest of
	// the model aggregates and sorts. A comp left at weight 0 would vanish
	// from the weighted median.
	return selection.entries.map((entry) => {
		entry.comp.weight = entry.weight;
		return entry.comp;
	});
}

/**
 * Parcel land-use class for plot comps. Two sources, cheapest first:
 *
 * 1. `parcel_meta.land_use` — written by the GUGiK RCN import for every
 *    powiat package it reads (`gruntyZabudowaneIZurbanizowane`,
 *    `gruntyRolne`, ...). It is the only land-use evidence a fresh install
 *    has, because the EGiB `parcels` import is a separate manual job
 *    (`EGIB_TILES_PER_REFRESH` defaults to 0).
 * 2. `parcels.land_use_class` — the EGiB class symbol, when that import ran.
 *
 * A missing row leaves the family unknown, which the plot filter treats as
 * "no evidence", not as agreement. Without the `parcel_meta` pass every RCN
 * plot comp was unknown, so a plot advert that named its type ("działka
 * budowlana") could not use a single RCN sale and fell back to listings only.
 */
async function parcelFamilies(
	rows: readonly RcnRow[],
): Promise<Map<string, PlotClassFamily>> {
	const ids = [
		...new Set(
			rows
				.map((row) => row.parcelId)
				.filter((id): id is string => id != null && id !== ""),
		),
	];
	const families = new Map<string, PlotClassFamily>();
	for (let offset = 0; offset < ids.length; offset += 400) {
		const chunk = ids.slice(offset, offset + 400);
		if (chunk.length === 0) continue;
		const meta = await db
			.select({
				parcelId: parcelMeta.parcelId,
				landUse: parcelMeta.landUse,
			})
			.from(parcelMeta)
			.where(inArray(parcelMeta.parcelId, chunk));
		for (const row of meta) {
			const family = plotClassFamily(row.landUse);
			if (family) families.set(row.parcelId, family);
		}
		const missing = chunk.filter((id) => !families.has(id));
		if (missing.length === 0) continue;
		const egib = await db
			.select({
				parcelId: parcels.parcelId,
				landUseClass: parcels.landUseClass,
			})
			.from(parcels)
			.where(inArray(parcels.parcelId, missing));
		for (const row of egib) {
			const family = plotClassFamily(row.landUseClass);
			if (family) families.set(row.parcelId, family);
		}
	}
	return families;
}

function compAddress(comp: {
	district: string | null;
	street?: string | null;
	streetNumber?: string | null;
	address?: string | null;
}): string | null {
	if (comp.address) return comp.address;
	const street = comp.street
		? `${comp.street}${comp.streetNumber ? ` ${comp.streetNumber}` : ""}`
		: null;
	return [street, comp.district].filter(Boolean).join(", ") || null;
}

function stats(comps: readonly WorkingComp[]): ValuationCompSet | null {
	if (comps.length === 0) return null;
	const values = comps.map((comp) => ({
		value: comp.adjustedPriceM2,
		weight: comp.weight,
	}));
	const median = weightedQuantile(values, 0.5);
	const p25 = weightedQuantile(values, 0.25);
	const p75 = weightedQuantile(values, 0.75);
	if (median == null || p25 == null || p75 == null) return null;
	return {
		n: comps.length,
		medianM2: median,
		p25M2: p25,
		p75M2: p75,
		weight: comps.reduce((sum, comp) => sum + comp.weight, 0),
	};
}

class IndexResolver {
	private readonly cache = new Map<string, Promise<IndexPoint[]>>();

	constructor(private readonly asOfPeriod = currentQuarter()) {}

	private series(input: {
		segment: IndexSegment;
		geographyType: IndexPoint["geographyType"];
		geographyKey: string;
		source?: string;
	}): Promise<IndexPoint[]> {
		const key = `${input.segment}|${input.source ?? "rcn"}|${input.geographyType}|${input.geographyKey}`;
		const cached = this.cache.get(key);
		if (cached) return cached;
		const promise = priceIndexSeries(input);
		this.cache.set(key, promise);
		return promise;
	}

	async adjust(comp: WorkingComp): Promise<{
		factor: number;
		replaced: boolean;
		source: string;
		geography: string;
		fromPeriod: string;
		toPeriod: string;
		segment: string;
	} | null> {
		if (comp.date == null) return null;
		const compPeriod = quarterOf(comp.date as Date | number);
		const trySeries = async (
			segment: IndexSegment,
			geographyType: IndexPoint["geographyType"],
			geographyKey: string,
			source: string,
		) => {
			const series = await this.series({
				segment,
				geographyType,
				geographyKey,
				source,
			});
			// One point is not a trend. Use a wider series before accepting
			// a no-change adjustment from a single observation.
			if (series.length < 2) return null;
			const adjustment = timeAdjustment(series, compPeriod, this.asOfPeriod);
			if (!adjustment) return null;
			return {
				factor: adjustment.factor,
				source,
				geography: `${geographyType}:${geographyKey}`,
				fromPeriod: adjustment.fromPeriod,
				toPeriod: adjustment.toPeriod,
				segment,
			};
		};

		const narrowGeographies: Array<{
			type: IndexPoint["geographyType"];
			key: string;
		}> = [];
		const district = normalizeDistrict(comp.district);
		if (district) narrowGeographies.push({ type: "district", key: district });
		if (comp.lat != null && comp.lng != null) {
			narrowGeographies.push({
				type: "grid10",
				key: grid10Key(comp.lat, comp.lng),
			});
		}
		const region =
			comp.region ??
			(comp.lat != null && comp.lng != null
				? regionOf(comp.lat, comp.lng)
				: null);
		const segment = indexSegmentFor({
			kind: comp.kind,
			market: comp.market,
		});
		const segments: IndexSegment[] =
			segment === "flat_primary" || segment === "flat_secondary"
				? [segment, "flat"]
				: [segment];
		// The regional factor is the reference the plausibility guard compares
		// a narrow grid/district factor against. Resolve it first so a chain
		// artifact (live: ×5.07 on a 2021 house comp) cannot slip through.
		let regionAdjustment: Awaited<ReturnType<typeof trySeries>> = null;
		for (const indexSegment of segments) {
			if (!region) break;
			regionAdjustment = await trySeries(indexSegment, "region", region, "rcn");
			if (regionAdjustment) break;
		}
		let narrowAdjustment: Awaited<ReturnType<typeof trySeries>> = null;
		outer: for (const indexSegment of segments) {
			for (const geography of narrowGeographies) {
				const adjustment = await trySeries(
					indexSegment,
					geography.type,
					geography.key,
					"rcn",
				);
				if (adjustment) {
					narrowAdjustment = adjustment;
					break outer;
				}
			}
		}
		if (narrowAdjustment) {
			if (regionAdjustment) {
				const guard = guardTimeFactor({
					factor: narrowAdjustment.factor,
					regionFactor: regionAdjustment.factor,
				});
				if (guard.replaced) {
					return { ...regionAdjustment, replaced: true };
				}
			}
			return { ...narrowAdjustment, replaced: false };
		}
		if (regionAdjustment) {
			return { ...regionAdjustment, replaced: false };
		}
		// Last resort for flats only: the city-level RCN reference (finwire).
		// It is a trend, not a price level, so it never becomes a comparable
		// on its own; it only brings an already location-filtered comparable
		// from its own quarter to today. Houses and plots have no external
		// series by design.
		if (comp.kind === "flat") {
			const externalCity = externalCityFor(comp.lat, comp.lng, region);
			if (externalCity) {
				for (const indexSegment of segments) {
					const adjustment = await trySeries(
						indexSegment,
						"external_city",
						externalCity,
						"finwire",
					);
					if (adjustment) return { ...adjustment, replaced: false };
				}
			}
		}
		return null;
	}
}

function toComparable(comp: WorkingComp): ValuationComparable {
	return {
		id: comp.id,
		source: comp.source,
		date: isoOf(comp.date),
		distanceM: comp.distanceM == null ? null : Math.round(comp.distanceM),
		areaM2: comp.areaM2,
		rooms: comp.rooms,
		address: comp.address,
		originalPrice: comp.price,
		originalPriceM2: Math.round(comp.pricePerM2),
		timeFactor: Math.round(comp.timeFactor * 1000) / 1000,
		areaFactor: Math.round(comp.sizeFactor * 1000) / 1000,
		adjustedPriceM2: Math.round(comp.adjustedPriceM2),
		indexSource: comp.indexSource,
		askingRatio: comp.askingRatio,
		indexGeography: comp.indexGeography,
		indexFromPeriod: comp.indexFromPeriod,
		indexToPeriod: comp.indexToPeriod,
	};
}

function confidenceFor(
	comps: readonly WorkingComp[],
	spreadPct: number,
	nowSeconds: number,
): {
	level: ValuationConfidenceLevel;
	rcnCount: number;
	listingCount: number;
	timeAdjustedCount: number;
	totalCount: number;
	spreadPct: number;
	sameBuildingCount: number;
} {
	const rcnCount = comps.filter((comp) => comp.source === "rcn").length;
	const listingCount = comps.length - rcnCount;
	const timeAdjustedCount = comps.filter(
		(comp) => comp.source === "rcn" && comp.indexSource != null,
	).length;
	const sameBuildingCount = comps.filter(
		(comp) => comp.set === "buildingRcn",
	).length;
	const recentCount = comps.filter((comp) => {
		const seconds = secondsOf(comp.date);
		return (
			comp.source === "rcn" &&
			seconds != null &&
			nowSeconds - seconds <= 365 * 86_400
		);
	}).length;
	const adjustedRatio = rcnCount > 0 ? timeAdjustedCount / rcnCount : 0;
	let score = Math.min(40, rcnCount * 5);
	score += sameBuildingCount > 0 ? 15 : 0;
	score += adjustedRatio >= 0.75 ? 15 : adjustedRatio >= 0.4 ? 8 : 0;
	score += spreadPct <= 20 ? 15 : spreadPct <= 35 ? 8 : 0;
	score += recentCount >= 3 ? 15 : recentCount >= 1 ? 8 : 0;
	if (rcnCount === 0) score = Math.min(score, 35);
	return {
		level: score >= 75 ? "high" : score >= 45 ? "medium" : "low",
		rcnCount,
		listingCount,
		timeAdjustedCount,
		totalCount: comps.length,
		spreadPct: Math.round(spreadPct * 10) / 10,
		sameBuildingCount,
	};
}

function ratingFor(
	offerM2: number | null,
	lowM2: number,
	highM2: number,
): { label: string; tone: string } | null {
	if (offerM2 == null) return null;
	if (offerM2 < lowM2) {
		return { label: "poniżej wartości godziwej", tone: "text-emerald-600" };
	}
	if (offerM2 > highM2) {
		return { label: "powyżej wartości godziwej", tone: "text-red-600" };
	}
	return { label: "w zakresie godziwym", tone: "text-gray-700" };
}

function makeListingComp(
	row: ListingRow,
	offer: OfferForValuation,
	askingRatio: number | null,
): WorkingComp | null {
	if (row.pricePerM2 == null || row.areaM2 == null || row.areaM2 <= 0) {
		return null;
	}
	if (offer.id != null && row.id === offer.id) return null;
	const kind = propertyKindOf({
		source: row.source,
		title: row.title,
		propertyType: row.propertyType,
		externalId: row.externalId,
	});
	const expected = offer.kind === "flat" ? "apartment" : offer.kind;
	if (kind !== expected) return null;
	if (HIDDEN_SOURCES.has(row.source) || AUCTION_SOURCES.has(row.source)) {
		return null;
	}
	const distanceM =
		offer.lat != null && offer.lng != null && row.lat != null && row.lng != null
			? haversineM(offer.lat, offer.lng, row.lat, row.lng)
			: null;
	const date = row.listedAt ?? row.firstSeenAt;
	const converted = convertCompPrice({
		source: "listing",
		pricePerM2: row.pricePerM2,
		askingRatio,
		size: {
			beta: AREA_ELASTICITY[offer.kind],
			compAreaM2: row.areaM2,
			targetAreaM2: offer.areaM2,
		},
	});
	const comp: WorkingComp = {
		id: `listing:${row.source}:${row.externalId}`,
		source: "listing",
		set: "listing",
		kind: offer.kind,
		date,
		price: row.price,
		pricePerM2: row.pricePerM2,
		areaM2: row.areaM2,
		rooms: row.rooms,
		district: row.district,
		address: compAddress(row),
		lat: row.lat,
		lng: row.lng,
		region: null,
		market: null,
		distanceM,
		timeFactor: converted.timeFactor,
		sizeFactor: converted.sizeFactor,
		adjustedPriceM2: converted.adjustedPriceM2,
		weight: 0,
		floor: row.floor,
		plotClassFamily: plotClassFamilyFromType(row.plotType),
		indexSource: converted.indexSource,
		askingRatio: converted.indexSource == null ? null : askingRatio,
		indexGeography: null,
		indexFromPeriod: null,
		indexToPeriod: null,
		indexSegment: null,
	};
	return comp;
}

async function listingComps(
	offer: OfferForValuation,
	nowSeconds: number,
	askingRatio: number | null,
): Promise<WorkingComp[]> {
	const area = offer.areaM2 as number;
	const [minM2, maxM2] = validM2(offer.kind);
	const filters = [
		eq(listings.offerType, "sale"),
		sql`${listings.pricePerM2} between ${minM2} and ${maxM2}`,
		sql`${listings.areaM2} between ${area * 0.25} and ${area * 4}`,
		sql`${listings.price} is not null`,
	];
	if (offer.lat != null && offer.lng != null) {
		const b = bbox(offer.lat, offer.lng, initialRadius(offer.kind));
		filters.push(
			sql`${listings.lat} between ${b.minLat} and ${b.maxLat}`,
			sql`${listings.lng} between ${b.minLng} and ${b.maxLng}`,
		);
	} else if (offer.district) {
		filters.push(
			sql`lower(${listings.district}) = ${offer.district.toLowerCase()}`,
		);
	} else {
		return [];
	}
	const rows = await db
		.select({
			id: listings.id,
			source: listings.source,
			externalId: listings.externalId,
			title: listings.title,
			price: listings.price,
			pricePerM2: listings.pricePerM2,
			areaM2: listings.areaM2,
			rooms: listings.rooms,
			district: listings.district,
			address: listings.address,
			lat: listings.lat,
			lng: listings.lng,
			listedAt: listings.listedAt,
			firstSeenAt: listings.firstSeenAt,
			propertyType: listings.propertyType,
			market: listings.market,
			buildingId: listings.buildingId,
			plotType: listings.plotType,
			floor: listings.floor,
		})
		.from(listings)
		.where(and(...filters))
		.orderBy(desc(listings.scrapedAt))
		.limit(400);
	const candidates = rows
		.map((row) => makeListingComp(row, offer, askingRatio))
		.filter((comp): comp is WorkingComp => comp != null);
	const selection = selectComparables(
		compTargetFor(offer, nowSeconds),
		candidates,
		selectionOptionsFor(offer.kind),
	);
	return selectedComps(selection);
}

async function rcnRows(
	offer: OfferForValuation,
	radiusM: number | null,
	nowSeconds: number,
): Promise<Array<{ row: RcnRow; set: CompSet; distanceM: number | null }>> {
	const area = offer.areaM2 as number;
	const [minM2, maxM2] = validM2(offer.kind);
	const baseFilters = [
		eq(transactions.kind, requiredKind(offer.kind)),
		sql`${transactions.date} >= ${nowSeconds - FIVE_YEARS_SECONDS}`,
		sql`${transactions.date} <= ${nowSeconds}`,
		sql`${transactions.pricePerM2} between ${minM2} and ${maxM2}`,
		sql`${transactions.areaM2} between ${area * 0.25} and ${area * 4}`,
	];
	const selection = {
		transactionId: transactions.transactionId,
		date: transactions.date,
		price: transactions.price,
		pricePerM2: transactions.pricePerM2,
		areaM2: transactions.areaM2,
		rooms: transactions.rooms,
		floor: transactions.floor,
		district: transactions.district,
		street: transactions.street,
		streetNumber: transactions.streetNumber,
		market: transactions.market,
		lat: transactions.lat,
		lng: transactions.lng,
		region: transactions.region,
		buildingId: transactions.buildingId,
		parcelId: transactions.parcelId,
	};
	const output: Array<{ row: RcnRow; set: CompSet; distanceM: number | null }> =
		[];
	if (offer.buildingId != null) {
		const rows = await db
			.select(selection)
			.from(transactions)
			.where(and(...baseFilters, eq(transactions.buildingId, offer.buildingId)))
			.orderBy(desc(transactions.date))
			.limit(80);
		for (const row of rows) {
			output.push({ row, set: "buildingRcn", distanceM: null });
		}
	}
	if (radiusM != null && offer.lat != null && offer.lng != null) {
		const b = bbox(offer.lat, offer.lng, radiusM);
		const rows = await db
			.select(selection)
			.from(transactions)
			.where(
				and(
					...baseFilters,
					sql`${transactions.lat} between ${b.minLat} and ${b.maxLat}`,
					sql`${transactions.lng} between ${b.minLng} and ${b.maxLng}`,
				),
			)
			.orderBy(
				sql`abs(${transactions.areaM2} - ${area})`,
				desc(transactions.date),
			)
			.limit(400);
		for (const row of rows) {
			const distanceM =
				row.lat != null && row.lng != null
					? haversineM(offer.lat, offer.lng, row.lat, row.lng)
					: null;
			output.push({ row, set: "nearbyRcn", distanceM });
		}
	} else if (offer.district) {
		const rows = await db
			.select(selection)
			.from(transactions)
			.where(
				and(
					...baseFilters,
					sql`lower(${transactions.district}) = ${offer.district.toLowerCase()}`,
				),
			)
			.orderBy(
				sql`abs(${transactions.areaM2} - ${area})`,
				desc(transactions.date),
			)
			.limit(400);
		for (const row of rows) {
			output.push({ row, set: "nearbyRcn", distanceM: null });
		}
	}
	return output;
}

function toRcnComp(
	input: { row: RcnRow; set: CompSet; distanceM: number | null },
	offer: OfferForValuation,
	families: Map<string, PlotClassFamily>,
): WorkingComp | null {
	const { row, set, distanceM } = input;
	if (row.pricePerM2 == null || row.areaM2 == null || row.areaM2 <= 0) {
		return null;
	}
	const comp: WorkingComp = {
		id: row.transactionId,
		source: "rcn",
		set,
		kind: offer.kind,
		date: row.date,
		price: row.price,
		pricePerM2: row.pricePerM2,
		areaM2: row.areaM2,
		rooms: row.rooms,
		district: row.district,
		address: compAddress(row),
		lat: row.lat,
		lng: row.lng,
		region: row.region,
		market: row.market,
		distanceM,
		timeFactor: 1,
		sizeFactor: 1,
		adjustedPriceM2: row.pricePerM2,
		weight: 0,
		floor: row.floor,
		plotClassFamily:
			row.parcelId == null ? null : (families.get(row.parcelId) ?? null),
		indexSource: null,
		askingRatio: null,
		indexGeography: null,
		indexFromPeriod: null,
		indexToPeriod: null,
		indexSegment: null,
	};
	return comp;
}

async function gatherRcnComps(
	offer: OfferForValuation,
	nowSeconds: number,
): Promise<WorkingComp[]> {
	const radius =
		offer.lat != null && offer.lng != null ? initialRadius(offer.kind) : null;
	const inputs = await rcnRows(offer, radius, nowSeconds);
	const seen = new Set<string>();
	const unique: typeof inputs = [];
	for (const input of inputs) {
		if (seen.has(input.row.transactionId)) continue;
		seen.add(input.row.transactionId);
		unique.push(input);
	}
	const families =
		offer.kind === "plot"
			? await parcelFamilies(unique.map((input) => input.row))
			: new Map<string, PlotClassFamily>();
	const candidates = unique
		.map((input) => toRcnComp(input, offer, families))
		.filter((comp): comp is WorkingComp => comp != null);
	const selection = selectComparables(
		compTargetFor(offer, nowSeconds),
		candidates,
		selectionOptionsFor(offer.kind),
	);
	return selectedComps(selection);
}

async function adjustComps(
	comps: WorkingComp[],
	asOfPeriod: string,
	targetAreaM2: number,
	areaElasticity: number,
): Promise<WorkingComp[]> {
	const resolver = new IndexResolver(asOfPeriod);
	const adjusted: WorkingComp[] = [];
	for (const comp of comps) {
		if (comp.source === "listing") {
			adjusted.push(comp);
			continue;
		}
		const index = await resolver.adjust(comp);
		if (!index) {
			comp.weight *= 0.7;
			adjusted.push(comp);
			continue;
		}
		if (index.replaced) comp.weight *= GUARDED_FACTOR_WEIGHT;
		const converted = convertCompPrice({
			source: "rcn",
			pricePerM2: comp.pricePerM2,
			timeFactor: index.factor,
			size: {
				beta: areaElasticity,
				compAreaM2: comp.areaM2,
				targetAreaM2,
			},
		});
		comp.timeFactor = converted.timeFactor;
		comp.sizeFactor = converted.sizeFactor;
		comp.adjustedPriceM2 = converted.adjustedPriceM2;
		comp.indexSource = index.source;
		comp.indexGeography = index.geography;
		comp.indexFromPeriod = index.fromPeriod;
		comp.indexToPeriod = index.toPeriod;
		comp.indexSegment = index.segment;
		adjusted.push(comp);
	}
	return adjusted;
}

function indexSummary(
	comps: readonly WorkingComp[],
): ValuationEstimate["index"] {
	const withIndex = comps.filter(
		(comp) => comp.source === "rcn" && comp.indexSource != null,
	);
	const first = withIndex.sort((a, b) => b.weight - a.weight)[0];
	if (!first) return null;
	return {
		source: first.indexSource as string,
		segment: first.indexSegment as string,
		geographyType: first.indexGeography?.split(":")[0] ?? "",
		geographyKey: first.indexGeography?.split(":").slice(1).join(":") ?? "",
		fromPeriod: first.indexFromPeriod as string,
		toPeriod: first.indexToPeriod as string,
	};
}

/**
 * The index series behind the applied time adjustment, so the forward
 * expectation uses the same market the comparables were adjusted with. Falls
 * back to the regional flat series when no comparable carried an index.
 */
async function momentumSeries(
	index: ValuationEstimate["index"],
	offer: OfferForValuation,
): Promise<IndexPoint[]> {
	if (index) {
		const series = await priceIndexSeries({
			segment: index.segment as IndexSegment,
			geographyType: index.geographyType as IndexPoint["geographyType"],
			geographyKey: index.geographyKey,
			source: index.source,
		});
		if (series.length >= 2) return series;
	}
	const region =
		offer.lat != null && offer.lng != null
			? regionOf(offer.lat, offer.lng)
			: null;
	if (!region) return [];
	const segment: IndexSegment = offer.kind === "flat" ? "flat" : offer.kind;
	return priceIndexSeries({
		segment,
		geographyType: "region",
		geographyKey: region,
	});
}

/**
 * The whole market as a reference: median, p25 and p75 transaction price per
 * m² for the offer's kind within 8 km (a city) over the last 24 months.
 *
 * This is deliberately not a valuation: a city median ignores the street, the
 * building and the condition, so it can only say "the market here is X". It is
 * shown beside a thin comp set (and used as the reason text when fewer than
 * three comparables exist) instead of pretending two comps are a valuation.
 */
async function marketMedianFor(
	offer: OfferForValuation,
	nowSeconds: number,
): Promise<MarketMedian | null> {
	if (offer.lat == null || offer.lng == null) return null;
	const [minM2, maxM2] = validM2(offer.kind);
	const months = 24;
	const since = nowSeconds - months * 30 * 86_400;
	const box = bbox(offer.lat, offer.lng, 8000);
	const rows = await db
		.select({ pricePerM2: transactions.pricePerM2 })
		.from(transactions)
		.where(
			and(
				eq(transactions.kind, requiredKind(offer.kind)),
				sql`${transactions.date} >= ${since}`,
				sql`${transactions.date} <= ${nowSeconds}`,
				sql`${transactions.pricePerM2} between ${minM2} and ${maxM2}`,
				sql`${transactions.lat} between ${box.minLat} and ${box.maxLat}`,
				sql`${transactions.lng} between ${box.minLng} and ${box.maxLng}`,
			),
		)
		.limit(5000);
	const values = rows
		.map((row) => row.pricePerM2)
		.filter((value): value is number => value != null && value > 0)
		.sort((a, b) => a - b);
	if (values.length < 20) return null;
	const quantile = (q: number) =>
		values[Math.min(values.length - 1, Math.floor(q * (values.length - 1)))];
	return {
		medianM2: Math.round(quantile(0.5)),
		p25M2: Math.round(quantile(0.25)),
		p75M2: Math.round(quantile(0.75)),
		sample: values.length,
		radiusM: 8000,
		months,
	};
}

/**
 * Estimate today's fair value from time-adjusted RCN comparables mixed with
 * the active asking offers in the same 1 km, capped at 30. A listing comp is
 * converted to the transaction level with the measured asking ratio; an RCN
 * comp is carried to today with the chain-linked index.
 */
export async function estimateSaleValue(
	offer: OfferForValuation,
	asOf = new Date(),
	options: {
		includeListings?: boolean;
		/**
		 * When false the estimate is a pure market value: the offer's own
		 * price is not required and is not used for the over/under rating or
		 * the upside model. Rentals need this because their `price` is a
		 * monthly rent, not a purchase price.
		 */
		compareToOffer?: boolean;
		/** Skip the forward-looking model when only the fair value is needed. */
		includeUpside?: boolean;
		/** Also measure the city-wide median (one extra aggregate query). */
		includeMarketMedian?: boolean;
	} = {},
): Promise<SaleValuationResult> {
	const compareToOffer = options.compareToOffer !== false;
	if (offer.areaM2 == null || offer.areaM2 <= 0) {
		return { estimate: null, reason: "missing_price_or_area" };
	}
	if (
		compareToOffer &&
		(offer.price == null ||
			offer.price <= 0 ||
			offer.pricePerM2 == null ||
			offer.pricePerM2 <= 0)
	) {
		return { estimate: null, reason: "missing_price_or_area" };
	}
	if (offer.buildingId == null && offer.lat == null && !offer.district) {
		return { estimate: null, reason: "missing_location" };
	}
	const nowSeconds = Math.floor(asOf.getTime() / 1000);
	const asOfPeriod = currentQuarter(asOf);
	const areaElasticity = AREA_ELASTICITY[offer.kind];
	const rcn = await gatherRcnComps(offer, nowSeconds);
	let comps = await adjustComps(rcn, asOfPeriod, offer.areaM2, areaElasticity);
	// The alert's evidence is the mixed set a buyer can verify: recorded sales
	// (time-adjusted to today) plus the active offers in the same 1 km, with
	// the asking side converted to the transaction level. Listings used to be
	// a fallback only when fewer than three RCN comps survived, which left a
	// house or plot with no RCN sale in its neighbourhood unscored.
	let asking: AskingRatio | null = null;
	if (options.includeListings !== false) {
		const offerRegion =
			offer.lat != null && offer.lng != null
				? regionOf(offer.lat, offer.lng)
				: null;
		asking = await askingToTransactionRatio(offer.kind, offerRegion);
		const fallback = await listingComps(offer, nowSeconds, asking.ratio);
		const existing = new Set(comps.map((comp) => comp.id));
		comps = [...comps, ...fallback.filter((comp) => !existing.has(comp.id))];
	}
	if (comps.length < 3) {
		const marketMedian = await marketMedianFor(offer, nowSeconds);
		return { estimate: null, reason: "insufficient_comps", marketMedian };
	}
	comps = comps.sort((a, b) => b.weight - a.weight).slice(0, 30);
	const overall = stats(comps);
	if (!overall) return { estimate: null, reason: "insufficient_comps" };
	const quality = qualityAdjustment({
		segment: offer.kind,
		facts: offer.facts ?? null,
		buildYear: offer.buildYear,
		buildingType: offer.buildingType,
		buildingMaterial: offer.buildingMaterial,
		condition: offer.condition,
		hasElevator: offer.hasElevator,
		floor: offer.floor,
		floorCount: offer.floorCount,
		plotType: offer.plotType,
		landUseClass: offer.landUseClass,
		zoningWz: offer.zoningWz,
		zoningPlanCount: offer.zoningPlanCount,
		roadDistanceM: offer.roadDistanceM,
		slopeDeg: offer.slopeDeg,
		floodRisk: offer.floodRisk,
		asOfYear: asOf.getUTCFullYear(),
	});
	const qualityFactor = 1 + quality.pct / 100;
	const metricM2 = estimateCompPrice(
		comps.map((comp) => ({
			value: comp.adjustedPriceM2,
			weight: comp.weight,
			areaM2: comp.areaM2,
		})),
		PRICE_METRIC,
	);
	const fairM2 = (metricM2 ?? overall.medianM2) * qualityFactor;
	const lowM2 = Math.min(overall.p25M2, overall.medianM2) * qualityFactor;
	const highM2 = Math.max(overall.p75M2, overall.medianM2) * qualityFactor;
	const offerM2 = compareToOffer ? offer.pricePerM2 : null;
	const overUnderPct =
		compareToOffer && offerM2 != null && fairM2 > 0
			? (offerM2 / fairM2 - 1) * 100
			: null;
	const spreadPct = fairM2 > 0 ? ((highM2 - lowM2) / fairM2) * 100 : 100;
	const discountGuard = implausibleDiscount({
		offerM2,
		fairM2,
		compCount: comps.length,
		p25M2: overall.p25M2,
		p75M2: overall.p75M2,
	});
	const confidence = confidenceFor(comps, spreadPct, nowSeconds);
	const area = offer.areaM2;
	const index = indexSummary(comps);
	const upside =
		compareToOffer && options.includeUpside !== false
			? upsidePotential({
					fairM2,
					offerM2,
					series: await momentumSeries(index, offer),
					compSpreadPct: spreadPct,
				})
			: null;
	const estimate: ValuationEstimate = {
		segment: offer.kind,
		fairM2: Math.round(fairM2),
		fairPrice: Math.round(fairM2 * area),
		lowM2: Math.round(lowM2),
		highM2: Math.round(highM2),
		lowPrice: Math.round(lowM2 * area),
		highPrice: Math.round(highM2 * area),
		overUnderPct:
			overUnderPct == null ? null : Math.round(overUnderPct * 10) / 10,
		rating: compareToOffer ? ratingFor(offerM2, lowM2, highM2) : null,
		confidence,
		comparables: comps.slice(0, 6).map(toComparable),
		compSets: {
			buildingRcn: stats(comps.filter((comp) => comp.set === "buildingRcn")),
			nearbyRcn: stats(comps.filter((comp) => comp.set === "nearbyRcn")),
			listing: stats(comps.filter((comp) => comp.set === "listing")),
		},
		index,
		qualityAdjustmentPct: quality.pct,
		qualityAdjustmentKnown: quality.known,
		qualityAdjustmentReasons: quality.reasons,
		metric: PRICE_METRIC,
		areaElasticity,
		implausibleDiscount: discountGuard.implausible,
		implausibleDiscountReason: discountGuard.reason,
		statistics: estimateStatistics(comps, asking, nowSeconds),
		upside,
	};
	const marketMedian = options.includeMarketMedian
		? await marketMedianFor(offer, nowSeconds)
		: null;
	return { estimate, reason: null, marketMedian };
}
