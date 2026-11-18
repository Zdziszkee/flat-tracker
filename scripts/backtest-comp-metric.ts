/**
 * Out-of-sample backtest for the fair-value price metric and the comparable
 * selection rules.
 *
 *   node --import tsx scripts/backtest-comp-metric.ts --n=3000 --kind=flat
 *
 * Method
 * ------
 * - Sample N held-out RCN transactions (seeded reservoir, default 3000) of one
 *   kind, in the two tracked voivodeships, with price, area, coordinates and
 *   date. Default `--since=2022-01-01` so the regional index (built from
 *   2020-Q4) has a history to adjust with.
 * - For each holdout, rebuild the comp set from the same transactions that
 *   existed at or before the holdout's own timestamp (no lookahead), excluding
 *   the transaction itself, any sale in the same OSM building and any sale on
 *   the same cadastral parcel (parcel hash; only the id and building are exact,
 *   the parcel exclusion is a 32-bit hash). Inside a 6 km box.
 * - Adjust each comp from its own quarter to the holdout's quarter with the
 *   chain-linked regional index (`price_indices`, source `rcn`), exactly the
 *   factor the model applies. When the narrow grid10 series has a factor it is
 *   compared with the regional factor for the same window (the plausibility
 *   guard ablation).
 * - Predict zł/m² with each estimator and compare with the holdout's own
 *   recorded zł/m². No quality correction and no asking ratio: RCN is a
 *   completed transaction and carries no condition facts.
 *
 * The first table compares the six estimators under the current selection,
 * then breaks the error down by comp-set size and region. The ablation table
 * changes one selection rule at a time. Numbers in the `comp-selection.ts`
 * header and constants come from this run.
 *
 * Results of record (2026-11, seed 20261118):
 *
 *   segment  n      current MedAPE   final MedAPE    final MAPE   ±20%
 *   flat     3000        14.8%            13.6%          25.5%     63.8%
 *   house    1500        27.4%            19.1%          50.2%     51.5%
 *   plot      308        38.3%            27.6%          63.7%     41.2%
 *
 * `current` = 140 cap, +-40% area band, hard rooms, 1500 m decay, 1200/2400 m.
 * `final` = 40 cap, +-15% strict band, soft rooms, 800 m decay, 800/1600 m,
 * index guard band 1.5, plot beta 0.9. Flats/houses use the weighted median
 * (runner-up plain median 15.6%/32.7%); plots keep it too (plain median 37.5%
 * on 308 holdouts is noise). The index guard alone moves houses 27.4% -> 23.7%
 * and plots 38.3% -> 28.2%. The discount guard withholds every deep-discount
 * estimate that was actually broken and no good one (flats 59/59, houses
 * 165/165, plots 45/45).
 *
 * Plot type agreement (kept on in the model as a safety rule, since a village
 * building plot must never be priced against forest or farmland) is measured
 * separately: on the 209 holdouts whose parcel carries a class it moves
 * MedAPE 38.3% -> 34.3% on its own, but on top of beta 0.9 + the index guard
 * it moves 27.6% -> 58.2% and loses 32% of estimates. The registry exposes a
 * land class for only 0.2% of plot transactions in this database, so the
 * agreeing comp sets are thin. Until the EGiB class coverage is imported, the
 * filter is a correctness guard, not an accuracy win; `requirePlotTypeAgreement`
 * is the switch.
 */

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import {
	type CompCandidate,
	type CompSelection,
	type CompTarget,
	DEFAULT_SELECTION,
	estimateCompPrice,
	type PlotClassFamily,
	plotClassFamily,
	type PriceMetric,
	selectComparables,
	type SelectionOptions,
} from "#/lib/valuation/comp-selection";
import { quarterOf, timeAdjustment } from "#/lib/valuation/price-index";
import type { IndexPoint } from "#/lib/valuation/price-index";
import { weightedQuantile as wq } from "#/lib/stats";

type Kind = "flat" | "house" | "plot";

function arg(name: string, fallback: string): string {
	const prefix = `--${name}=`;
	const found = process.argv.find((value) => value.startsWith(prefix));
	return found ? found.slice(prefix.length) : fallback;
}

const N = Number.parseInt(arg("n", "3000"), 10);
const KIND = arg("kind", "flat") as Kind;
const SEED = Number.parseInt(arg("seed", "20261118"), 10);
const SINCE = arg("since", "2022-01-01");
const METRIC = arg("metric", "weighted_median") as PriceMetric;
const ONLY = arg("only", "all"); // all | estimators | ablations
const PLOT_SAMPLE = arg("plot-sample", "classified"); // classified | all

/**
 * Holdout prices outside these bands are registry/data errors (a 500 zł/m²
 * flat in Kraków is a partial-share or mis-keyed row), not market evidence.
 * Excluding them from the *holdout* sample keeps MAPE meaningful; comps keep
 * the wider filter so the estimator still has to be robust to bad input.
 */
const HOLD_BANDS: Record<Kind, [number, number]> = {
	flat: [1500, 30_000],
	house: [100, 20_000],
	plot: [0.5, 10_000],
};

if (!["flat", "house", "plot"].includes(KIND)) {
	console.error(`unknown --kind=${KIND}`);
	process.exit(2);
}

/* ---------------------------- seeded PRNG ---------------------------- */

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/* ------------------------------- pool -------------------------------- */

const FAMILY_CODES: Array<PlotClassFamily | null> = [
	null,
	"built",
	"agricultural",
	"forest",
	"water",
	"other",
];
const FAMILY_INDEX = new Map<string, number>([
	["built", 1],
	["agricultural", 2],
	["forest", 3],
	["water", 4],
	["other", 5],
]);

function familyCode(family: PlotClassFamily | null): number {
	return family == null ? 0 : (FAMILY_INDEX.get(family) ?? 5);
}

function familyOf(code: number): PlotClassFamily | null {
	return FAMILY_CODES[code] ?? null;
}

function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Cross-sectional elasticity of zł/m² on area: ln(ppm) = a - beta * ln(area),
 * so `beta` is the percentage drop in zł/m² per 1% more area. Fitted on the
 * pool minus the sampled holdouts (out of sample for every holdout) and on
 * the last three years only, so the 2005-2015 price level cannot masquerade
 * as an area effect.
 */
function fitAreaElasticity(
	pool: Pool,
	excluded: Set<number>,
	nowSeconds: number,
): { beta: number; n: number; r2: number } {
	const since = nowSeconds - 3 * 365 * 86_400;
	let n = 0;
	let sx = 0;
	let sy = 0;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	for (let i = 0; i < pool.n; i++) {
		if (excluded.has(i)) continue;
		if ((pool.date[i] as number) < since) continue;
		const area = pool.area[i] as number;
		const ppm = pool.ppm[i] as number;
		if (!(area > 0) || !(ppm > 0)) continue;
		const x = Math.log(area);
		const y = Math.log(ppm);
		n++;
		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
		syy += y * y;
	}
	if (n < 50) return { beta: 0, n, r2: 0 };
	const sxxC = sxx - (sx * sx) / n;
	const syyC = syy - (sy * sy) / n;
	const sxyC = sxy - (sx * sy) / n;
	if (sxxC <= 0) return { beta: 0, n, r2: 0 };
	const slope = sxyC / sxxC;
	const r2 = syyC > 0 ? (sxyC * sxyC) / (sxxC * syyC) : 0;
	return { beta: -slope, n, r2 };
}

function floorValue(value: string | null): number {
	if (value == null) return -128;
	const normalized = value.trim().toLowerCase();
	if (normalized === "parter") return 0;
	if (normalized === "suterena") return -1;
	const match = normalized.match(/-?\d+/);
	if (!match) return -128;
	const parsed = Number.parseInt(match[0], 10);
	return Number.isFinite(parsed) && parsed > -128 && parsed < 128 ? parsed : -128;
}

interface Pool {
	kind: Kind;
	n: number;
	lat: Float64Array;
	lng: Float64Array;
	area: Float64Array;
	ppm: Float64Array;
	date: Float64Array;
	rooms: Int16Array;
	/** Floor number; -128 when the registry has none. */
	floor: Int16Array;
	market: Int8Array;
	building: Int32Array;
	parcelHash: Uint32Array;
	family: Uint8Array;
	region: Uint8Array;
	buckets: Map<string, number[]>;
	regionOf: (index: number) => string;
}

function kindFilterSQL(kind: Kind) {
	if (kind === "flat") {
		return sql`t.kind = 'unit' and t.areaM2 between 10 and 250 and t.pricePerM2 between 500 and 60000`;
	}
	if (kind === "house") {
		return sql`t.kind = 'building' and t.areaM2 between 20 and 2000 and t.pricePerM2 between 100 and 40000`;
	}
	return sql`t.kind = 'parcel' and t.areaM2 between 50 and 100000 and t.pricePerM2 between 0.01 and 20000`;
}

async function loadPool(kind: Kind): Promise<Pool> {
	const base = sql`t.region is not null and t.price > 0
		and t.lat is not null and t.lng is not null
		and ${kindFilterSQL(kind)}`;
	const countRows = await db.all<{ n: number }>(
		sql`select count(*) n from transactions t where ${base}`,
	);
	const total = countRows[0]?.n ?? 0;
	const pool: Pool = {
		kind,
		n: 0,
		lat: new Float64Array(total),
		lng: new Float64Array(total),
		area: new Float64Array(total),
		ppm: new Float64Array(total),
		date: new Float64Array(total),
		rooms: new Int16Array(total),
		floor: new Int16Array(total),
		market: new Int8Array(total),
		building: new Int32Array(total),
		parcelHash: new Uint32Array(total),
		family: new Uint8Array(total),
		region: new Uint8Array(total),
		buckets: new Map(),
		regionOf: (index) => (pool.region[index] === 1 ? "malopolskie" : "slaskie"),
	};
	let last = 0;
	let written = 0;
	for (;;) {
		const rows = await db.all<{
			id: number;
			lat: number;
			lng: number;
			area: number;
			ppm: number;
			secs: number;
			rooms: number | null;
			floor: string | null;
			market: number | null;
			building: number | null;
			parcelId: string | null;
			landClass: string | null;
			region: string | null;
		}>(sql`
			select t.id as id, t.lat as lat, t.lng as lng, t.areaM2 as area,
				t.pricePerM2 as ppm, cast(t.date as integer) as secs,
				t.rooms as rooms, t.floor as floor, t.market as market,
				t.building_id as building,
				t.parcel_id as parcelId, p.land_use_class as landClass,
				t.region as region
			from transactions t
			left join parcels p on p."parcelId" = t.parcel_id
			where ${base} and t.id > ${last}
			order by t.id
			limit 5000
		`);
		if (rows.length === 0) break;
		for (const row of rows) {
			pool.lat[written] = row.lat;
			pool.lng[written] = row.lng;
			pool.area[written] = row.area;
			pool.ppm[written] = row.ppm;
			pool.date[written] = row.secs;
			pool.rooms[written] = row.rooms ?? -1;
			pool.floor[written] = floorValue(row.floor);
			pool.market[written] = row.market ?? 0;
			pool.building[written] = row.building ?? -1;
			pool.parcelHash[written] = row.parcelId ? fnv1a(row.parcelId) : 0;
			pool.family[written] = familyCode(plotClassFamily(row.landClass));
			pool.region[written] = row.region === "malopolskie" ? 1 : 2;
			const bucket = `${Math.round(row.lat * 100)}:${Math.round(row.lng * 100)}`;
			const list = pool.buckets.get(bucket);
			if (list) list.push(written);
			else pool.buckets.set(bucket, [written]);
			written++;
			last = row.id;
		}
	}
	pool.n = written;
	return pool;
}

/* ------------------------------- index ------------------------------- */

type IndexMap = Map<string, IndexPoint[]>;

async function loadIndices(): Promise<IndexMap> {
	const segments =
		KIND === "flat"
			? ["flat", "flat_primary", "flat_secondary"]
			: [KIND === "house" ? "house" : "plot"];
	const rows = await db.all<{
		segment: string;
		geo: string;
		key: string;
		period: string;
		indexValue: number;
		sampleCount: number;
	}>(sql`
		select segment, geography_type as geo, geography_key as key, period,
			index_value as indexValue, sample_count as sampleCount
		from price_indices
		where source = 'rcn' and geography_type in ('region', 'grid10')
			and segment in (${sql.join(segments.map((s) => sql`${s}`), sql`, `)})
		order by segment, geo, key, period
	`);
	const map: IndexMap = new Map();
	for (const row of rows) {
		const key = `${row.segment}|${row.geo}|${row.key}`;
		const list = map.get(key) ?? [];
		list.push({
			segment: row.segment as IndexPoint["segment"],
			geographyType: row.geo as IndexPoint["geographyType"],
			geographyKey: row.key,
			period: row.period,
			indexValue: row.indexValue,
			medianPriceM2: null,
			sampleCount: row.sampleCount,
			source: "rcn",
		});
		map.set(key, list);
	}
	return map;
}

function segmentsFor(kind: Kind, market: number | null): string[] {
	if (kind !== "flat") return [kind === "house" ? "house" : "plot"];
	if (market === 1) return ["flat_primary", "flat"];
	if (market === 2) return ["flat_secondary", "flat"];
	return ["flat"];
}

const factorCache = new Map<string, number | null>();

function gridKeyOf(lat: number, lng: number): string {
	return `${lat.toFixed(1)}:${lng.toFixed(1)}`;
}

/** Factor from a stored series; null when the series is too thin. */
function factorOfSeries(
	indices: IndexMap,
	segment: string,
	geo: "region" | "grid10",
	key: string,
	fromPeriod: string,
	toPeriod: string,
): number | null {
	const cacheKey = `${segment}|${geo}|${key}|${fromPeriod}|${toPeriod}`;
	const cached = factorCache.get(cacheKey);
	if (cached !== undefined) return cached;
	const series = indices.get(`${segment}|${geo}|${key}`);
	let factor: number | null = null;
	if (series && series.length >= 2) {
		factor = timeAdjustment(series, fromPeriod, toPeriod)?.factor ?? null;
	}
	factorCache.set(cacheKey, factor);
	return factor;
}

/**
 * The model resolves the comp's market segment first, falling back to the
 * whole-flat series. `primaryIndex` forces the whole-flat series, testing
 * whether the primary/secondary split helps.
 */
function factorsFor(
	indices: IndexMap,
	kind: Kind,
	market: number | null,
	lat: number,
	lng: number,
	region: string,
	fromPeriod: string,
	toPeriod: string,
	primaryIndex: boolean,
): { narrow: number | null; region: number | null } {
	const segments = primaryIndex && kind === "flat" ? ["flat"] : segmentsFor(kind, market);
	let narrow: number | null = null;
	let regionFactor: number | null = null;
	for (const segment of segments) {
		regionFactor ??= factorOfSeries(
			indices,
			segment,
			"region",
			region,
			fromPeriod,
			toPeriod,
		);
		narrow ??= factorOfSeries(
			indices,
			segment,
			"grid10",
			gridKeyOf(lat, lng),
			fromPeriod,
			toPeriod,
		);
	}
	return { narrow, region: regionFactor };
}

/* ----------------------------- candidates ---------------------------- */

interface Cand extends CompCandidate {
	idx: number;
	ppm: number;
	/** Factor from the comp's own grid10 series to the holdout quarter. */
	narrowFactor: number | null;
	/** Regional factor over the same window. */
	regionFactor: number | null;
	region: string;
}

const RADIUS_BY_KIND: Record<Kind, number> = {
	flat: 2400,
	house: 4000,
	plot: 6000,
};

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
	const rad = Math.PI / 180;
	const dLat = (lat2 - lat1) * rad;
	const dLng = (lng2 - lng1) * rad;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function gatherCandidates(
	pool: Pool,
	indices: IndexMap,
	holdout: number,
	primaryIndex: boolean,
): Cand[] {
	const lat = pool.lat[holdout] as number;
	const lng = pool.lng[holdout] as number;
	const toPeriod = quarterOf(pool.date[holdout] as number);
	const maxRadius = RADIUS_BY_KIND[pool.kind];
	const dLat = maxRadius / 111_320;
	const dLng = maxRadius / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
	const minBx = Math.round((lng - dLng) * 100);
	const maxBx = Math.round((lng + dLng) * 100);
	const minBy = Math.round((lat - dLat) * 100);
	const maxBy = Math.round((lat + dLat) * 100);
	const out: Cand[] = [];
	const holdoutBuilding = pool.building[holdout] ?? -1;
	const holdoutParcel = pool.parcelHash[holdout] ?? 0;
	const holdoutDate = pool.date[holdout] as number;
	for (let bx = minBx; bx <= maxBx; bx++) {
		for (let by = minBy; by <= maxBy; by++) {
			const bucket = pool.buckets.get(`${by}:${bx}`);
			if (!bucket) continue;
			for (const idx of bucket) {
				if (idx === holdout) continue;
				const date = pool.date[idx] as number;
				if (date > holdoutDate) continue;
				const candidateBuilding = pool.building[idx] ?? -1;
				if (holdoutBuilding >= 0 && candidateBuilding === holdoutBuilding) {
					// Same building as the holdout: this is the leakage the
					// backtest must avoid, and the model would use it.
					continue;
				}
				const candidateParcel = pool.parcelHash[idx] ?? 0;
				if (holdoutParcel !== 0 && candidateParcel === holdoutParcel) continue;
				const distanceM = haversine(lat, lng, pool.lat[idx] as number, pool.lng[idx] as number);
				if (distanceM > maxRadius) continue;
				const market = (pool.market[idx] as number) || null;
				const compRegion = pool.region[idx] === 1 ? "malopolskie" : "slaskie";
				const factors = factorsFor(
					indices,
					pool.kind,
					market,
					pool.lat[idx] as number,
					pool.lng[idx] as number,
					compRegion,
					quarterOf(date),
					toPeriod,
					primaryIndex,
				);
				out.push({
					idx,
					ppm: pool.ppm[idx] as number,
					narrowFactor: factors.narrow,
					regionFactor: factors.region,
					region: compRegion,
					set:
						holdoutBuilding >= 0 && candidateBuilding === holdoutBuilding
							? "buildingRcn"
							: "nearbyRcn",
					date,
					areaM2: pool.area[idx] as number,
					rooms: (pool.rooms[idx] as number) >= 0 ? (pool.rooms[idx] as number) : null,
					market,
					distanceM,
					plotClassFamily: familyOf(pool.family[idx] as number),
					floor:
						(pool.floor[idx] as number) === -128
							? null
							: String(pool.floor[idx]),
					buildingId: candidateBuilding >= 0 ? candidateBuilding : null,
				});
			}
		}
	}
	return out;
}

/* ------------------------------ config ------------------------------- */

interface GuardOptions {
	/** null = no guard (current production behaviour). */
	band: number | null;
	/** Weight multiplier when the narrow factor was replaced. */
	downweight: number;
	/** Weight multiplier when no factor at all was available. */
	missingFactorWeight: number;
}

interface Config {
	name: string;
	metric: PriceMetric;
	selection: SelectionOptions;
	guard: GuardOptions;
	primaryIndex: boolean;
	/** Positive area elasticity: value = ppm * (compArea / targetArea)^beta. */
	beta: number;
}

/**
 * The pre-backtest policy, kept here so the "current" row is reproducible
 * after the defaults were changed to the measured winner. Values: +-40%
 * strict band, hard rooms, 1500 m decay, 140 cap, historic radii.
 */
const HISTORIC_SELECTION: SelectionOptions = {
	bands: [
		{ minRatio: 0.6, maxRatio: 1.4, rooms: "exact", market: "match" },
		{ minRatio: 0.5, maxRatio: 2, rooms: "one", market: "match" },
		{ minRatio: 0.25, maxRatio: 4, rooms: "any", market: "any" },
	],
	radiiM:
		KIND === "flat"
			? [1200, 2400]
			: KIND === "house"
				? [2000, 4000]
				: [3000, 6000],
	minComps: 3,
	cap: 140,
	maxAgeSeconds: 5 * 365 * 86_400,
	distanceScaleM: 1500,
	recencyHalfLifeMonths: 24,
	roomsMode: "filter",
	floorMode: "none",
	requirePlotTypeAgreement: false,
	listingWeightMultiplier: 0.5,
	marketMode: "filter",
	marketSoftWeight: 0.5,
};

const BASE_SELECTION = HISTORIC_SELECTION;

function cloneSelection(over: Partial<SelectionOptions>): SelectionOptions {
	return {
		...BASE_SELECTION,
		bands: BASE_SELECTION.bands.map((band) => ({ ...band })),
		...over,
	};
}

const NO_GUARD: GuardOptions = { band: null, downweight: 1, missingFactorWeight: 0.7 };
const BASE_CONFIG: Config = {
	name: "current",
	metric: METRIC,
	selection: cloneSelection({}),
	guard: NO_GUARD,
	primaryIndex: false,
	beta: 0,
};

/* --------------------------- measurement ----------------------------- */

interface Observation {
	err: number; // predicted / actual - 1
	count: number;
	region: string;
	actual: number;
	predicted: number;
}

function bandFor(count: number): string {
	if (count <= 5) return "3-5";
	if (count <= 15) return "6-15";
	if (count <= 40) return "16-40";
	return "41+";
}

interface Summary {
	name: string;
	n: number;
	noEstimatePct: number;
	mape: number;
	/** Mean absolute error in zł/m². */
	mae: number;
	medApe: number;
	rmse: number;
	within10: number;
	within20: number;
	meanBias: number;
	medianBias: number;
}

function summarize(name: string, observations: Observation[], total: number): Summary {
	const errors = observations.map((row) => row.err);
	const abs = errors.map(Math.abs);
	const pct = (value: number) => value * 100;
	const mean = (values: number[]) =>
		values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;
	const med = (values: number[]) =>
		wq(
			values.map((value) => ({ value, weight: 1 })),
			0.5,
		) ?? Number.NaN;
	return {
		name,
		n: observations.length,
		noEstimatePct: total === 0 ? 0 : ((total - observations.length) / total) * 100,
		mape: pct(mean(abs)),
		mae: mean(observations.map((row) => Math.abs(row.predicted - row.actual))),
		medApe: pct(med(abs)),
		rmse: pct(Math.sqrt(mean(errors.map((error) => error * error)))),
		within10: pct(abs.filter((error) => error <= 0.1).length / Math.max(1, abs.length)),
		within20: pct(abs.filter((error) => error <= 0.2).length / Math.max(1, abs.length)),
		meanBias: pct(mean(errors)),
		medianBias: pct(med(errors)),
	};
}

interface HoldoutComps {
	holdout: number;
	candidates: Cand[];
	target: CompTarget;
	actual: number;
	region: string;
}

function targetFor(pool: Pool, holdout: number): CompTarget {
	const rooms = pool.rooms[holdout] as number;
	const market = pool.market[holdout] as number;
	return {
		kind: pool.kind,
		areaM2: pool.area[holdout] as number,
		rooms: rooms >= 0 ? rooms : null,
		market: market === 1 || market === 2 ? market : null,
		asOfSeconds: pool.date[holdout] as number,
		plotClassFamily:
			pool.kind === "plot" ? familyOf(pool.family[holdout] as number) : null,
		floor:
			(pool.floor[holdout] as number) === -128
				? null
				: String(pool.floor[holdout]),
	};
}

function adjustedEntries(
	selection: CompSelection<Cand>,
	guard: GuardOptions,
	targetAreaM2: number,
	areaElasticity: number,
): Array<{ value: number; weight: number; areaM2: number }> {
	const entries: Array<{ value: number; weight: number; areaM2: number }> = [];
	for (const entry of selection.entries) {
		const comp = entry.comp;
		let factor: number;
		let weight = entry.weight;
		if (guard.band != null) {
			const narrow = comp.narrowFactor;
			const region = comp.regionFactor;
			if (narrow == null) {
				factor = region ?? 1;
				if (region == null) weight *= guard.missingFactorWeight;
			} else if (region == null) {
				factor = narrow;
			} else {
				const ratio = narrow / region;
				const replaced = ratio > guard.band || ratio < 1 / guard.band;
				factor = replaced ? region : narrow;
				if (replaced) weight *= guard.downweight;
			}
		} else {
			const narrow = comp.narrowFactor;
			const region = comp.regionFactor;
			if (narrow != null) {
				factor = narrow;
			} else if (region != null) {
				factor = region;
			} else {
				factor = 1;
				weight *= guard.missingFactorWeight;
			}
		}
		// A smaller unit genuinely trades at a higher zł/m². The elasticity is
		// positive: value = ppm * (compArea / targetArea) ^ beta.
		const sizeFactor =
			areaElasticity === 0
				? 1
				: (comp.areaM2 / Math.max(targetAreaM2, 1e-6)) ** areaElasticity;
		const value = comp.ppm * factor * sizeFactor;
		if (!Number.isFinite(value) || value <= 0) continue;
		if (!Number.isFinite(weight) || weight <= 0) continue;
		entries.push({ value, weight, areaM2: comp.areaM2 });
	}
	return entries;
}

function runConfig(config: Config, holdouts: HoldoutComps[]): {
	summary: Summary;
	observations: Observation[];
	selectionMeta: Map<number, { count: number; p25: number; p75: number; err: number }>;
	guardReplacements: number;
	worst: Array<{ err: number; actual: number; predicted: number; count: number }>;
} {
	const observations: Observation[] = [];
	const selectionMeta = new Map<
		number,
		{ count: number; p25: number; p75: number; err: number }
	>();
	let guardReplacements = 0;
	const worst: Array<{
		err: number;
		actual: number;
		predicted: number;
		count: number;
	}> = [];
	for (const item of holdouts) {
		const selection = selectComparables(item.target, item.candidates, config.selection);
		if (selection.entries.length < 3) continue;
		if (config.guard.band != null) {
			for (const entry of selection.entries) {
				const narrow = entry.comp.narrowFactor;
				const region = entry.comp.regionFactor;
				if (narrow == null || region == null) continue;
				const ratio = narrow / region;
				if (ratio > config.guard.band || ratio < 1 / config.guard.band) {
					guardReplacements++;
				}
			}
		}
		const entries = adjustedEntries(
			selection,
			config.guard,
			item.target.areaM2,
			config.beta,
		);
		if (entries.length < 3) continue;
		const prediction = estimateCompPrice(entries, config.metric);
		if (prediction == null || !(prediction > 0)) continue;
		const err = prediction / item.actual - 1;
		observations.push({
			err,
			count: entries.length,
			region: item.region,
			actual: item.actual,
			predicted: prediction,
		});
		worst.push({ err, actual: item.actual, predicted: prediction, count: entries.length });
		const p25 = wq(entries.map(({ value, weight }) => ({ value, weight })), 0.25);
		const p75 = wq(entries.map(({ value, weight }) => ({ value, weight })), 0.75);
		selectionMeta.set(item.holdout, {
			count: entries.length,
			p25: p25 ?? prediction,
			p75: p75 ?? prediction,
			err,
		});
	}
	worst.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
	return {
		summary: summarize(config.name, observations, holdouts.length),
		observations,
		selectionMeta,
		guardReplacements,
		worst: worst.slice(0, 8),
	};
}

/* ------------------------------ tables ------------------------------- */

function pad(value: string, width: number): string {
	return value.length >= width ? value : value.padStart(width);
}

function printTable(
	title: string,
	headers: string[],
	rows: Array<Array<string | number>>,
): void {
	console.log(`\n=== ${title} ===`);
	const cells = rows.map((row) =>
		row.map((cell) =>
			typeof cell === "number"
				? Number.isFinite(cell)
					? cell.toFixed(1)
					: "n/a"
				: String(cell),
		),
	);
	const widths = headers.map((header, index) =>
		Math.max(
			header.length,
			...cells.map((row) => (row[index] ?? "").length),
		),
	);
	console.log(headers.map((header, i) => pad(header, widths[i] ?? 0)).join("  "));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of cells) {
		console.log(row.map((cell, i) => pad(cell, widths[i] ?? 0)).join("  "));
	}
}

/* ------------------------------- main -------------------------------- */

async function main(): Promise<void> {
	console.log(
		`backtest kind=${KIND} n=${N} seed=${SEED} since=${SINCE} metric=${METRIC} ` +
			`plot-sample=${PLOT_SAMPLE}`,
	);
	const pool = await loadPool(KIND);
	console.log(`pool: ${pool.n} eligible ${KIND} transactions`);
	const indices = await loadIndices();
	console.log(`index series: ${indices.size}`);

	const sinceSeconds = Math.floor(new Date(SINCE).getTime() / 1000);
	let classifiedPlots = 0;
	for (let i = 0; i < pool.n; i++) {
		if ((pool.family[i] ?? 0) !== 0) classifiedPlots++;
	}
	if (KIND === "plot") {
		console.log(
			`plot class coverage: ${classifiedPlots}/${pool.n} ` +
				`(${((classifiedPlots / Math.max(1, pool.n)) * 100).toFixed(1)}%)`,
		);
	}

	// Seeded reservoir over eligible holdouts.
	const rng = mulberry32(SEED);
	const sampled: number[] = [];
	let seen = 0;
	for (let i = 0; i < pool.n; i++) {
		if ((pool.date[i] as number) < sinceSeconds) continue;
		const ppm = pool.ppm[i] as number;
		const band = HOLD_BANDS[KIND];
		if (ppm < band[0] || ppm > band[1]) continue;
		if (KIND === "plot" && PLOT_SAMPLE === "classified" && (pool.family[i] ?? 0) === 0) {
			continue;
		}
		seen++;
		if (sampled.length < N) {
			sampled.push(i);
		} else {
			const j = Math.floor(rng() * seen);
			if (j < N) sampled[j] = i;
		}
	}
	console.log(`holdout pool: ${seen}, sampled: ${sampled.length}`);

	const elasticity = fitAreaElasticity(
		pool,
		new Set(sampled),
		Math.floor(Date.now() / 1000),
	);
	console.log(
		`fitted area elasticity beta=${elasticity.beta.toFixed(3)} ` +
			`(n=${elasticity.n}, R2=${elasticity.r2.toFixed(3)})`,
	);

	const holdouts: HoldoutComps[] = [];
	let unknownPlotFamily = 0;
	for (const holdout of sampled) {
		const target = targetFor(pool, holdout);
		if (KIND === "plot" && target.plotClassFamily == null) unknownPlotFamily++;
		holdouts.push({
			holdout,
			candidates: gatherCandidates(pool, indices, holdout, BASE_CONFIG.primaryIndex),
			target,
			actual: pool.ppm[holdout] as number,
			region: pool.region[holdout] === 1 ? "malopolskie" : "slaskie",
		});
	}
	const compCounts = holdouts.map((item) => item.candidates.length).sort((a, b) => a - b);
	console.log(
		`candidates/holdout: median ${compCounts[Math.floor(compCounts.length / 2)] ?? 0}, ` +
			`p90 ${compCounts[Math.floor(compCounts.length * 0.9)] ?? 0}` +
			(KIND === "plot" ? `, unknown-family holdouts ${unknownPlotFamily}` : ""),
	);
	let withNarrow = 0;
	let withRegion = 0;
	let candidateTotal = 0;
	for (const item of holdouts) {
		for (const candidate of item.candidates) {
			candidateTotal++;
			if (candidate.narrowFactor != null) withNarrow++;
			if (candidate.regionFactor != null) withRegion++;
		}
	}
	const ratio = (value: number) =>
		((value / Math.max(1, candidateTotal)) * 100).toFixed(1);
	console.log(
		`factor coverage: grid10 ${ratio(withNarrow)}%, region ${ratio(withRegion)}% ` +
			`of ${candidateTotal} candidate links`,
	);

	const metrics: PriceMetric[] = [
		"weighted_median",
		"median",
		"mean",
		"area_weighted_median",
		"trimmed_mean",
		"huber",
	];
	const estimatorRuns = new Map<PriceMetric, ReturnType<typeof runConfig>>();
	if (ONLY !== "ablations") {
		for (const metric of metrics) {
			estimatorRuns.set(
				metric,
				runConfig({ ...BASE_CONFIG, metric, name: metric }, holdouts),
			);
		}
		const rows = metrics.map((metric) => {
			const summary = estimatorRuns.get(metric)?.summary;
			return [
				metric,
				summary?.n ?? 0,
				summary?.mape ?? Number.NaN,
				summary?.medApe ?? Number.NaN,
				summary?.rmse ?? Number.NaN,
				summary?.within10 ?? Number.NaN,
				summary?.within20 ?? Number.NaN,
				summary?.meanBias ?? Number.NaN,
				summary?.medianBias ?? Number.NaN,
			];
		});
		printTable(
			`Estimators (current selection, guard off): ${KIND}`,
			[
				"metric",
				"n",
				"MAPE%",
				"MedAPE%",
				"RMSE%",
				"±10%",
				"±20%",
				"meanBias%",
				"medBias%",
			],
			rows,
		);

		for (const bucket of ["3-5", "6-15", "16-40", "41+"]) {
			const bucketRows = metrics.map((metric) => {
				const observations = estimatorRuns
					.get(metric)
					?.observations.filter((row) => bandFor(row.count) === bucket) ?? [];
				const summary = summarize(`${metric} ${bucket}`, observations, observations.length);
				return [
					metric,
					summary.n,
					summary.mape,
					summary.medApe,
					summary.within20,
				];
			});
			printTable(
				`Estimators by comp-set size ${bucket}: ${KIND}`,
				["metric", "n", "MAPE%", "MedAPE%", "±20%"],
				bucketRows,
			);
		}

		for (const region of ["malopolskie", "slaskie"]) {
			const regionRows = metrics.map((metric) => {
				const observations = estimatorRuns
					.get(metric)
					?.observations.filter((row) => row.region === region) ?? [];
				const summary = summarize(`${metric} ${region}`, observations, observations.length);
				return [metric, summary.n, summary.mape, summary.medApe, summary.within20];
			});
			printTable(
				`Estimators by region ${region}: ${KIND}`,
				["metric", "n", "MAPE%", "MedAPE%", "±20%"],
				regionRows,
			);
		}
	}

	if (ONLY === "estimators") return;

	const base = estimatorRuns.get(METRIC) ?? runConfig(BASE_CONFIG, holdouts);
	printTable(
		`Worst |error| estimates (metric=${METRIC}): ${KIND}`,
		["actual", "predicted", "err%", "comps"],
		base.worst.map((row) => [
			Math.round(row.actual),
			Math.round(row.predicted),
			row.err * 100,
			row.count,
		]),
	);
	const ablations: Config[] = [];
	const narrowBand = { ...DEFAULT_SELECTION.bands[0]! };
	const bandsWith = (first: Partial<typeof narrowBand>): SelectionOptions["bands"] => [
		{ ...narrowBand, ...first },
		{ ...DEFAULT_SELECTION.bands[1]! },
		{ ...DEFAULT_SELECTION.bands[2]! },
	];
	const add = (name: string, over: Partial<SelectionOptions>, guard = NO_GUARD) => {
		ablations.push({
			name,
			metric: METRIC,
			selection: cloneSelection(over),
			guard,
			primaryIndex: false,
			beta: 0,
		});
	};

	ablations.push(BASE_CONFIG);
	const betaValues = [0.1, 0.15, 0.25, elasticity.beta].filter(
		(value, index, all) => value > 0 && all.findIndex((other) => Math.abs(other - value) < 1e-6) === index,
	);
	for (const beta of betaValues) {
		ablations.push({
			name: `beta ${beta.toFixed(3)}`,
			metric: METRIC,
			selection: cloneSelection({}),
			guard: NO_GUARD,
			primaryIndex: false,
			beta,
		});
	}
	ablations.push({
		name: "beta fitted + area none",
		metric: METRIC,
		selection: cloneSelection({
			bands: bandsWith({ minRatio: 0.01, maxRatio: 100 }),
		}),
		guard: NO_GUARD,
		primaryIndex: false,
		beta: elasticity.beta,
	});
	ablations.push({
		name: "combined (cap40, ±15, rooms pref, d800, r800)",
		metric: METRIC,
		selection: cloneSelection({
			bands: bandsWith({ minRatio: 0.87, maxRatio: 1.15 }),
			roomsMode: "preferred",
			distanceScaleM: 800,
			radiiM: [800, 1600],
			cap: 40,
		}),
		guard: NO_GUARD,
		primaryIndex: false,
		beta: 0,
	});
	const combinedSelection = cloneSelection({
		bands: bandsWith({ minRatio: 0.87, maxRatio: 1.15 }),
		roomsMode: "preferred",
		distanceScaleM: 800,
		radiiM: [800, 1600],
		cap: 40,
	});
	ablations.push({
		name: "final candidate: combined + guard 1.5",
		metric: METRIC,
		selection: combinedSelection,
		guard: { band: 1.5, downweight: 0.5, missingFactorWeight: 0.7 },
		primaryIndex: false,
		beta: 0,
	});
	if (KIND === "house") {
		ablations.push({
			name: "final candidate + beta 0.25",
			metric: METRIC,
			selection: combinedSelection,
			guard: { band: 1.5, downweight: 0.5, missingFactorWeight: 0.7 },
			primaryIndex: false,
			beta: 0.25,
		});
	}
	if (KIND === "plot") {
		ablations.push({
			name: "plot final: beta 0.9 + guard 1.5",
			metric: METRIC,
			selection: cloneSelection({}),
			guard: { band: 1.5, downweight: 0.5, missingFactorWeight: 0.7 },
			primaryIndex: false,
			beta: 0.9,
		});
		ablations.push({
			name: "plot final + type agreement",
			metric: METRIC,
			selection: cloneSelection({ requirePlotTypeAgreement: true }),
			guard: { band: 1.5, downweight: 0.5, missingFactorWeight: 0.7 },
			primaryIndex: false,
			beta: 0.9,
		});
	}

	if (KIND === "flat") {
		add("area ±15%", { bands: bandsWith({ minRatio: 0.87, maxRatio: 1.15 }) });
		add("area ±30%", { bands: bandsWith({ minRatio: 0.77, maxRatio: 1.3 }) });
		add("area none", { bands: bandsWith({ minRatio: 0.01, maxRatio: 100 }) });
		add("rooms preferred", { roomsMode: "preferred" });
		add("rooms none", { roomsMode: "none" });
		add("floor ±1", { floorMode: "one" });
		add("distance 800", { distanceScaleM: 800 });
		add("distance 3000", { distanceScaleM: 3000 });
		add("distance uniform", { distanceScaleM: 1e9 });
		add("radius 800/1600", { radiiM: [800, 1600] });
		add("radius 600/1200", { radiiM: [600, 1200] });
		add("cap 40", { cap: 40 });
		add("cap unbounded", { cap: 100_000 });
		add("window all", { maxAgeSeconds: Number.POSITIVE_INFINITY });
		add("minComps 5", { minComps: 5 });
		add("market soft 0.5", { marketMode: "soft", marketSoftWeight: 0.5 });
		add("market soft 1.0", { marketMode: "soft", marketSoftWeight: 1 });
		add("market none", { marketMode: "none" });
	}
	if (KIND === "plot") {
		add("plot type agreement", { requirePlotTypeAgreement: true });
		add("plot type agreement + area ±30%", {
			requirePlotTypeAgreement: true,
			bands: bandsWith({ minRatio: 0.7, maxRatio: 1.3 }),
		});
		add("plot area ±30%", { bands: bandsWith({ minRatio: 0.7, maxRatio: 1.3 }) });
		add("plot area ±15%", { bands: bandsWith({ minRatio: 0.87, maxRatio: 1.15 }) });
		add("plot area none", { bands: bandsWith({ minRatio: 0.01, maxRatio: 100 }) });
		add("cap 40", { cap: 40 });
		add("minComps 5", { minComps: 5 });
		add("window all", { maxAgeSeconds: Number.POSITIVE_INFINITY });
	}
	// Guards apply to every kind.
	ablations.push({
		name: "index guard band 2, w 0.5",
		metric: METRIC,
		selection: cloneSelection({}),
		guard: { band: 2, downweight: 0.5, missingFactorWeight: 0.7 },
		primaryIndex: false,
		beta: 0,
	});
	ablations.push({
		name: "index guard band 2, w 1.0",
		metric: METRIC,
		selection: cloneSelection({}),
		guard: { band: 2, downweight: 1, missingFactorWeight: 0.7 },
		primaryIndex: false,
		beta: 0,
	});
	ablations.push({
		name: "index guard band 1.5",
		metric: METRIC,
		selection: cloneSelection({}),
		guard: { band: 1.5, downweight: 0.5, missingFactorWeight: 0.7 },
		primaryIndex: false,
		beta: 0,
	});
	if (KIND === "flat") {
		ablations.push({
			name: "flat index (no primary split)",
			metric: METRIC,
			selection: cloneSelection({}),
			guard: NO_GUARD,
			primaryIndex: true,
			beta: 0,
		});
	}

	const baseMedApe = base.summary.medApe;
	const ablationRows = ablations.map((config) => {
		const run = config === BASE_CONFIG ? base : runConfig(config, holdouts);
		return [
			config.name,
			run.summary.n,
			run.summary.noEstimatePct,
			run.summary.medApe,
			run.summary.mape,
			Math.round(run.summary.mae),
			run.summary.within20,
			run.summary.medApe - baseMedApe,
			run.summary.meanBias,
			run.guardReplacements,
		];
	});
	printTable(
		`Selection ablations (metric=${METRIC}): ${KIND}`,
		[
			"change",
			"n",
			"noEst%",
			"MedAPE%",
			"MAPE%",
			"MAE zł/m²",
			"±20%",
			"ΔMedAPE",
			"meanBias%",
			"guardRepl",
		],
		ablationRows,
	);

	// Implausible-discount guard, measured on the base run: treat the holdout's
	// true price as the offer price and ask whether the guard would have
	// withheld the estimate.
	const baseMeta = base.selectionMeta;
	const actualByHoldout = new Map(holdouts.map((item) => [item.holdout, item.actual]));
	let extreme = 0;
	let deep = 0;
	let deepExtreme = 0;
	let withheld = 0;
	let withheldBad = 0;
	let withheldGood = 0;
	let keptExtreme = 0;
	for (const [holdout, meta] of baseMeta) {
		const actual = actualByHoldout.get(holdout);
		if (actual == null) continue;
		const predicted = actual / (1 + meta.err);
		const isExtreme = Math.abs(meta.err) > 0.4;
		if (isExtreme) extreme++;
		const discountPct = (actual / predicted - 1) * 100;
		if (discountPct <= -45) {
			deep++;
			if (isExtreme) deepExtreme++;
		}
		const iqrRatio =
			(Math.max(meta.p75, predicted) - Math.min(meta.p25, predicted)) / predicted;
		const guard = discountPct <= -45 && (meta.count < 5 || iqrRatio > 0.8);
		if (guard) {
			withheld++;
			if (isExtreme) withheldBad++;
			else withheldGood++;
		} else if (isExtreme) {
			keptExtreme++;
		}
	}
	const baseCount = base.observations.length;
	printTable(
		`Extreme-error and discount guard (metric=${METRIC}): ${KIND}`,
		["measure", "count", "share%"],
		[
			["estimates", baseCount, 100],
			["|error| > 40%", extreme, (extreme / Math.max(1, baseCount)) * 100],
			["implied discount <= -45%", deep, (deep / Math.max(1, baseCount)) * 100],
			[
				"...of which |error| > 40%",
				deepExtreme,
				(deepExtreme / Math.max(1, deep)) * 100,
			],
			["guard withholds", withheld, (withheld / Math.max(1, baseCount)) * 100],
			[
				"...withheld that were bad",
				withheldBad,
				(withheldBad / Math.max(1, withheld)) * 100,
			],
			[
				"...withheld that were good",
				withheldGood,
				(withheldGood / Math.max(1, withheld)) * 100,
			],
			[
				"|error| > 40% kept",
				keptExtreme,
				(keptExtreme / Math.max(1, baseCount)) * 100,
			],
		],
	);
	console.log(
		"\nNote: the extreme-error pairing uses weighted-quantile p25/p75 per comp set; " +
			"it is a measurement of the guard rule, not of the alert pipeline.",
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
