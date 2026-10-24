import { and, desc, eq, sql } from "drizzle-orm";

import { HIDDEN_SOURCES } from "#/crawler/hidden-sources";
import { db } from "#/db/index";
import { priceIndexSeries } from "#/db/queries/price-indices";
import { regionOf } from "#/db/region";
import { listings, transactions } from "#/db/schema";
import { propertyKindOf } from "#/lib/property-kind";
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
	adjustedPriceM2: number;
	weight: number;
	indexSource: string | null;
	indexGeography: string | null;
	indexFromPeriod: string | null;
	indexToPeriod: string | null;
	indexSegment: string | null;
}

const AUCTION_SOURCES = new Set(["licytacje-komornik", "mapalicytacji"]);
const FIVE_YEARS_SECONDS = 5 * 365 * 86_400;

export interface SaleValuationResult {
	estimate: ValuationEstimate | null;
	reason: string | null;
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

function initialRadius(kind: ValuationSegment): number {
	if (kind === "flat") return 1200;
	if (kind === "house") return 2000;
	return 3000;
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

function areaRatioMatches(ratio: number, relaxation: 0 | 1 | 2): boolean {
	if (relaxation === 0) return ratio >= 0.6 && ratio <= 1.4;
	if (relaxation === 1) return ratio >= 0.5 && ratio <= 2;
	return ratio >= 0.25 && ratio <= 4;
}

function matchesOffer(
	comp: Pick<WorkingComp, "areaM2" | "rooms" | "market">,
	offer: OfferForValuation,
	relaxation: 0 | 1 | 2,
): boolean {
	const ratio = comp.areaM2 / (offer.areaM2 as number);
	if (!areaRatioMatches(ratio, relaxation)) return false;
	if (offer.kind === "flat" && offer.rooms != null && comp.rooms != null) {
		if (relaxation === 0 && comp.rooms !== offer.rooms) return false;
		if (relaxation === 1 && Math.abs(comp.rooms - offer.rooms) > 1) {
			return false;
		}
	}
	const wantedMarket = offerMarket(offer);
	if (
		offer.kind === "flat" &&
		wantedMarket != null &&
		comp.market != null &&
		relaxation < 2 &&
		comp.market !== wantedMarket
	) {
		return false;
	}
	return true;
}

function preliminaryWeight(
	comp: Pick<
		WorkingComp,
		"areaM2" | "rooms" | "market" | "distanceM" | "date" | "set"
	>,
	offer: OfferForValuation,
	nowSeconds: number,
): number {
	const ageMonths = Math.max(
		0,
		(nowSeconds - (secondsOf(comp.date) ?? nowSeconds)) / (30.44 * 86_400),
	);
	const recency = 0.5 ** (ageMonths / 24);
	const distance =
		comp.distanceM == null ? 0.85 : 1 / (1 + comp.distanceM / 1500);
	const areaSimilarity =
		1 / (1 + Math.abs(Math.log(comp.areaM2 / (offer.areaM2 as number))));
	let rooms = 1;
	if (offer.kind === "flat" && offer.rooms != null) {
		if (comp.rooms == null) rooms = 0.85;
		else if (comp.rooms === offer.rooms) rooms = 1;
		else if (Math.abs(comp.rooms - offer.rooms) === 1) rooms = 0.8;
		else rooms = 0.55;
	}
	const wantedMarket = offerMarket(offer);
	const market =
		wantedMarket != null && comp.market != null && comp.market !== wantedMarket
			? 0.65
			: 1;
	const building = comp.set === "buildingRcn" ? 2 : 1;
	return recency * distance * areaSimilarity * rooms * market * building;
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

		const geographies: Array<{
			type: IndexPoint["geographyType"];
			key: string;
		}> = [];
		const district = normalizeDistrict(comp.district);
		if (district) geographies.push({ type: "district", key: district });
		if (comp.lat != null && comp.lng != null) {
			geographies.push({
				type: "grid10",
				key: grid10Key(comp.lat, comp.lng),
			});
		}
		const region =
			comp.region ??
			(comp.lat != null && comp.lng != null
				? regionOf(comp.lat, comp.lng)
				: null);
		if (region) geographies.push({ type: "region", key: region });
		const segment = indexSegmentFor({
			kind: comp.kind,
			market: comp.market,
		});
		const segments: IndexSegment[] =
			segment === "flat_primary" || segment === "flat_secondary"
				? [segment, "flat"]
				: [segment];
		// RCN first: a district or grid10 series is the closest evidence, and
		// every local series beats an external city-wide one.
		for (const indexSegment of segments) {
			for (const geography of geographies) {
				const adjustment = await trySeries(
					indexSegment,
					geography.type,
					geography.key,
					"rcn",
				);
				if (adjustment) return adjustment;
			}
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
					if (adjustment) return adjustment;
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
		adjustedPriceM2: Math.round(comp.adjustedPriceM2),
		indexSource: comp.indexSource,
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
	nowSeconds: number,
): WorkingComp | null {
	if (row.pricePerM2 == null || row.areaM2 == null || row.areaM2 <= 0) {
		return null;
	}
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
		timeFactor: 1,
		adjustedPriceM2: row.pricePerM2,
		weight: 0,
		indexSource: null,
		indexGeography: null,
		indexFromPeriod: null,
		indexToPeriod: null,
		indexSegment: null,
	};
	comp.weight = preliminaryWeight(comp, offer, nowSeconds) * 0.5;
	return comp;
}

async function listingComps(
	offer: OfferForValuation,
	nowSeconds: number,
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
		const b = bbox(offer.lat, offer.lng, initialRadius(offer.kind) * 2);
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
		})
		.from(listings)
		.where(and(...filters))
		.orderBy(desc(listings.scrapedAt))
		.limit(400);
	return rows
		.map((row) => makeListingComp(row, offer, nowSeconds))
		.filter((comp): comp is WorkingComp => comp != null)
		.filter((comp) => matchesOffer(comp, offer, 2));
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
	nowSeconds: number,
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
		adjustedPriceM2: row.pricePerM2,
		weight: 0,
		indexSource: null,
		indexGeography: null,
		indexFromPeriod: null,
		indexToPeriod: null,
		indexSegment: null,
	};
	comp.weight = preliminaryWeight(comp, offer, nowSeconds);
	return comp;
}

async function gatherRcnComps(
	offer: OfferForValuation,
	nowSeconds: number,
): Promise<WorkingComp[]> {
	const seen = new Set<string>();
	const all: WorkingComp[] = [];
	const radius =
		offer.lat != null && offer.lng != null ? initialRadius(offer.kind) : null;
	for (const multiplier of [1, 2]) {
		const rows = await rcnRows(
			offer,
			radius == null ? null : radius * multiplier,
			nowSeconds,
		);
		for (const input of rows) {
			if (seen.has(input.row.transactionId)) continue;
			seen.add(input.row.transactionId);
			const comp = toRcnComp(input, offer, nowSeconds);
			if (comp) all.push(comp);
		}
		const strict = all.filter((comp) => matchesOffer(comp, offer, 0));
		if (strict.length >= 3) break;
		if (radius == null) break;
	}
	for (const relaxation of [0, 1, 2] as const) {
		const filtered = all.filter((comp) =>
			matchesOffer(comp, offer, relaxation),
		);
		if (filtered.length >= 3 || relaxation === 2) {
			return filtered.sort((a, b) => b.weight - a.weight).slice(0, 140);
		}
	}
	return [];
}

async function adjustComps(
	comps: WorkingComp[],
	asOfPeriod: string,
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
		comp.timeFactor = index.factor;
		comp.adjustedPriceM2 = comp.pricePerM2 * index.factor;
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
	const withIndex = comps.filter((comp) => comp.indexSource != null);
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
 * Estimate today's fair value from time-adjusted RCN comparables. Active
 * asking offers are only a fallback when fewer than three RCN comps survive.
 */
export async function estimateSaleValue(
	offer: OfferForValuation,
	asOf = new Date(),
	options: { includeListings?: boolean } = {},
): Promise<SaleValuationResult> {
	if (
		offer.price == null ||
		offer.price <= 0 ||
		offer.areaM2 == null ||
		offer.areaM2 <= 0 ||
		offer.pricePerM2 == null ||
		offer.pricePerM2 <= 0
	) {
		return { estimate: null, reason: "missing_price_or_area" };
	}
	if (offer.buildingId == null && offer.lat == null && !offer.district) {
		return { estimate: null, reason: "missing_location" };
	}
	const nowSeconds = Math.floor(asOf.getTime() / 1000);
	const asOfPeriod = currentQuarter(asOf);
	const rcn = await gatherRcnComps(offer, nowSeconds);
	let comps = await adjustComps(rcn, asOfPeriod);
	if (
		options.includeListings !== false &&
		comps.filter((comp) => comp.source === "rcn").length < 3
	) {
		const fallback = await listingComps(offer, nowSeconds);
		const existing = new Set(comps.map((comp) => comp.id));
		comps = [...comps, ...fallback.filter((comp) => !existing.has(comp.id))];
	}
	if (comps.length < 3) {
		return { estimate: null, reason: "insufficient_comps" };
	}
	comps = comps.sort((a, b) => b.weight - a.weight).slice(0, 140);
	const overall = stats(comps);
	if (!overall) return { estimate: null, reason: "insufficient_comps" };
	const fairM2 = overall.medianM2;
	const lowM2 = Math.min(overall.p25M2, fairM2);
	const highM2 = Math.max(overall.p75M2, fairM2);
	const offerM2 = offer.pricePerM2;
	const overUnderPct =
		offerM2 != null && fairM2 > 0 ? (offerM2 / fairM2 - 1) * 100 : null;
	const spreadPct = fairM2 > 0 ? ((highM2 - lowM2) / fairM2) * 100 : 100;
	const confidence = confidenceFor(comps, spreadPct, nowSeconds);
	const area = offer.areaM2;
	const index = indexSummary(comps);
	const upside = upsidePotential({
		fairM2,
		offerM2,
		series: await momentumSeries(index, offer),
		compSpreadPct: spreadPct,
	});
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
		rating: ratingFor(offerM2, lowM2, highM2),
		confidence,
		comparables: comps.slice(0, 6).map(toComparable),
		compSets: {
			buildingRcn: stats(comps.filter((comp) => comp.set === "buildingRcn")),
			nearbyRcn: stats(comps.filter((comp) => comp.set === "nearbyRcn")),
			listing: stats(comps.filter((comp) => comp.set === "listing")),
		},
		index,
		upside,
	};
	return { estimate, reason: null };
}
