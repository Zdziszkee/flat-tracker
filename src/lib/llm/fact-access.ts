/**
 * Typed reader over the model-extracted facts prompt v2 stores in
 * `listing_facts.facts_json`.
 *
 * Scoring and valuation should not parse that JSON themselves: this module
 * owns the shape and exposes one small projection (`ScoredFacts`) with the
 * facts those layers reason about, plus the id-based loader they call once
 * per run.
 *
 * Mapping notes:
 * - `heating` keeps the extraction vocabulary; `FactsHeating` is the same
 *   set minus "unknown", which normalization already turns into null.
 * - `buildingStyle` folds the extraction's finer `buildingType` into the
 *   five styles scoring distinguishes. A block whose technology is prefab
 *   (wielka płyta) becomes `largePanel`; detached/semi/townhouse are houses.
 * - `plot` is present only when the text carries plot evidence. Utilities
 *   alone do not make a flat a plot.
 * - A row that projects to nothing meaningful is dropped, so a caller can
 *   treat "no entry" as "no facts".
 */
import { inArray } from "drizzle-orm";

import { listingFacts } from "#/db/schema";
import { type ListingFacts, normalizeFacts } from "./listing-facts.ts";

export type FactsHeating =
	| "district"
	| "heatPump"
	| "gas"
	| "electric"
	| "coalWood"
	| "oil";

export type FactsBuildingStyle =
	| "tenement"
	| "block"
	| "largePanel"
	| "apartment"
	| "house";

export interface FactsPlot {
	type: string | null;
	media: {
		power: boolean;
		water: boolean;
		gas: boolean;
		sewer: boolean;
		internet: boolean;
	};
	mediaCount: number;
	roadAccess: "public" | "private" | "none" | null;
	wz: boolean | null;
	mpzpPurpose: string | null;
	mpzpSymbol: string | null;
	shape: "regular" | "irregular" | "narrow" | null;
	dimensions: string | null;
	slope: "flat" | "gentle" | "steep" | null;
}

export interface FactsContext {
	lake: boolean;
	river: boolean;
	forest: boolean;
	mountains: boolean;
	view: string | null;
}

export interface ScoredFacts {
	heating: FactsHeating | null;
	buildingStyle: FactsBuildingStyle | null;
	condition: "excellent" | "veryGood" | "good" | "toRenovation" | null;
	/** Primary (developer/first sale) or secondary market, when the ad says. */
	market: "primary" | "secondary" | null;
	buildYear: number | null;
	floor: number | null;
	floorCount: number | null;
	technology: string | null;
	insulation: boolean | null;
	floorHeating: boolean | null;
	heatPump: boolean | null;
	recuperation: boolean | null;
	airConditioning: boolean | null;
	photovoltaics: boolean | null;
	parkingSpots: number | null;
	plotAreaM2: number | null;
	gardenM2: number | null;
	legalStatus:
		| "own"
		| "cooperative"
		| "perpetual_usufruct"
		| "share"
		| "unknown"
		| null;
	encumbrances: string[];
	defects: string[];
	tenanted: boolean | null;
	plot: FactsPlot | null;
	context: FactsContext | null;
	monthlyCosts: {
		rent: number | null;
		funduszRemontowy: number | null;
		advance: number | null;
		mediaIncluded: boolean | null;
		agencyFeePct: number | null;
	} | null;
}

const HEATING: readonly FactsHeating[] = [
	"district",
	"heatPump",
	"gas",
	"electric",
	"coalWood",
	"oil",
];

const LEGAL: readonly NonNullable<ScoredFacts["legalStatus"]>[] = [
	"own",
	"cooperative",
	"perpetual_usufruct",
	"share",
	"unknown",
];

const CONDITIONS: readonly NonNullable<ScoredFacts["condition"]>[] = [
	"excellent",
	"veryGood",
	"good",
	"toRenovation",
];

const CONDITION_MAP: Record<string, NonNullable<ScoredFacts["condition"]>> = {
	excellent: "excellent",
	very_good: "veryGood",
	good: "good",
	to_renovation: "toRenovation",
};

const ROAD_ACCESS: readonly NonNullable<FactsPlot["roadAccess"]>[] = [
	"public",
	"private",
	"none",
];

const SHAPES: readonly NonNullable<FactsPlot["shape"]>[] = [
	"regular",
	"irregular",
	"narrow",
];

const SLOPES: readonly NonNullable<FactsPlot["slope"]>[] = [
	"flat",
	"gentle",
	"steep",
];

const MARKETS: readonly NonNullable<ScoredFacts["market"]>[] = [
	"primary",
	"secondary",
];

/**
 * The single-pass contract, made mechanical: every field the projection
 * exposes, and the prompt keys it is derived from. `validate:facts` rejects a
 * projection key missing here and a prompt key missing from the schema, so a
 * consumer can never need a field the model was not asked for.
 */
export const SCORED_FACT_SOURCES: Record<keyof ScoredFacts, readonly string[]> =
	{
		heating: ["heating"],
		buildingStyle: ["buildingType", "largePanel", "technology"],
		condition: ["condition"],
		market: ["market"],
		buildYear: ["buildYear"],
		floor: ["floor"],
		floorCount: ["floorCount"],
		technology: ["technology"],
		insulation: ["insulation"],
		floorHeating: ["floorHeating"],
		heatPump: ["heatPump"],
		recuperation: ["recuperation"],
		airConditioning: ["airConditioning"],
		photovoltaics: ["photovoltaics"],
		parkingSpots: ["parkingSpots"],
		plotAreaM2: ["plotAreaM2"],
		gardenM2: ["gardenM2"],
		legalStatus: ["legalStatus"],
		encumbrances: ["encumbrances"],
		defects: ["defects"],
		tenanted: ["tenanted"],
		plot: [
			"plotType",
			"roadAccess",
			"mpzpSymbol",
			"mpzpPurpose",
			"buildingPermitWz",
			"plotShape",
			"plotDimensions",
			"plotSlope",
			"fencing",
			"utilities",
		],
		context: ["context"],
		monthlyCosts: ["monthlyCosts"],
	};

/** Every top-level key `ScoredFacts` exposes, for the coverage check. */
export const SCORED_FACTS_KEYS = Object.keys(
	SCORED_FACT_SOURCES,
) as readonly (keyof ScoredFacts)[];

/** Nested keys of the projection, pinned the same way. */
export const FACTS_PLOT_KEYS = [
	"type",
	"media",
	"mediaCount",
	"roadAccess",
	"wz",
	"mpzpPurpose",
	"mpzpSymbol",
	"shape",
	"dimensions",
	"slope",
] as const satisfies readonly (keyof FactsPlot)[];

export const FACTS_CONTEXT_KEYS = [
	"lake",
	"river",
	"forest",
	"mountains",
	"view",
] as const satisfies readonly (keyof FactsContext)[];

export const FACTS_MONTHLY_COST_KEYS = [
	"rent",
	"funduszRemontowy",
	"advance",
	"mediaIncluded",
	"agencyFeePct",
] as const satisfies readonly (
	| keyof NonNullable<ScoredFacts["monthlyCosts"]>
	| "deposit"
)[];

function pick<T extends string>(
	value: string | null | undefined,
	allowed: readonly T[],
): T | null {
	if (typeof value !== "string") return null;
	return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function heatingOf(facts: ListingFacts): FactsHeating | null {
	return pick(facts.heating, HEATING);
}

function styleOf(facts: ListingFacts): FactsBuildingStyle | null {
	// A direct wielka płyta answer wins over the derived guess.
	if (facts.largePanel === true) return "largePanel";
	switch (facts.buildingType) {
		case "tenement":
			return "tenement";
		case "block":
			return facts.technology === "prefab" ? "largePanel" : "block";
		case "apartment":
			return "apartment";
		case "house":
		case "detached":
		case "semi_detached":
		case "townhouse":
			return "house";
		default:
			return null;
	}
}

function conditionOf(facts: ListingFacts): ScoredFacts["condition"] {
	if (!facts.condition) return null;
	return pick(CONDITION_MAP[facts.condition], CONDITIONS);
}

function plotOf(facts: ListingFacts): FactsPlot | null {
	const hasPlotEvidence =
		facts.plotType != null ||
		facts.roadAccess != null ||
		facts.mpzpSymbol != null ||
		facts.mpzpPurpose != null ||
		facts.buildingPermitWz != null ||
		facts.plotShape != null ||
		facts.plotDimensions != null ||
		facts.plotSlope != null ||
		facts.fencing != null;
	if (!hasPlotEvidence) return null;
	const media = {
		power: facts.utilities?.power ?? false,
		water: facts.utilities?.water ?? false,
		gas: facts.utilities?.gas ?? false,
		sewer: facts.utilities?.sewer ?? false,
		internet: facts.utilities?.internet ?? false,
	};
	const mediaCount = Object.values(media).filter(Boolean).length;
	return {
		type: facts.plotType,
		media,
		mediaCount,
		roadAccess: pick(facts.roadAccess, ROAD_ACCESS),
		wz: facts.buildingPermitWz,
		mpzpPurpose: facts.mpzpPurpose,
		mpzpSymbol: facts.mpzpSymbol,
		shape: pick(facts.plotShape, SHAPES),
		dimensions: facts.plotDimensions,
		slope: pick(facts.plotSlope, SLOPES),
	};
}

function contextOf(facts: ListingFacts): FactsContext | null {
	const context = facts.context;
	if (!context) return null;
	return {
		lake: context.lake,
		river: context.river,
		forest: context.forest,
		mountains: context.mountains,
		view: context.view,
	};
}

/** Whether the projection says anything at all. */
function hasContent(facts: ScoredFacts): boolean {
	const scalars = [
		facts.heating,
		facts.buildingStyle,
		facts.condition,
		facts.market,
		facts.buildYear,
		facts.floor,
		facts.floorCount,
		facts.technology,
		facts.insulation,
		facts.floorHeating,
		facts.heatPump,
		facts.recuperation,
		facts.airConditioning,
		facts.photovoltaics,
		facts.parkingSpots,
		facts.plotAreaM2,
		facts.gardenM2,
		facts.legalStatus,
		facts.tenanted,
		facts.plot,
		facts.context,
		facts.monthlyCosts,
	];
	if (scalars.some((value) => value != null)) return true;
	return facts.encumbrances.length > 0 || facts.defects.length > 0;
}

/**
 * Project a raw `facts_json` object (or a freshly normalized answer) onto
 * the scoring view. Malformed input yields null.
 */
export function scoredFactsOf(
	raw: Record<string, unknown> | null | undefined,
): ScoredFacts | null {
	if (!raw) return null;
	const facts = normalizeFacts(raw);
	if (!facts) return null;
	const scored: ScoredFacts = {
		heating: heatingOf(facts),
		buildingStyle: styleOf(facts),
		condition: conditionOf(facts),
		market: pick(facts.market, MARKETS),
		buildYear: facts.buildYear,
		floor: facts.floor,
		floorCount: facts.floorCount,
		technology: facts.technology,
		insulation: facts.insulation,
		floorHeating: facts.floorHeating,
		heatPump: facts.heatPump,
		recuperation: facts.recuperation,
		airConditioning: facts.airConditioning,
		photovoltaics: facts.photovoltaics,
		parkingSpots: facts.parkingSpots,
		plotAreaM2: facts.plotAreaM2,
		gardenM2: facts.gardenM2,
		legalStatus: pick(facts.legalStatus, LEGAL),
		encumbrances: facts.encumbrances ?? [],
		defects: facts.defects ?? [],
		tenanted: facts.tenanted,
		plot: plotOf(facts),
		context: contextOf(facts),
		monthlyCosts: facts.monthlyCosts
			? {
					rent: facts.monthlyCosts.rent,
					funduszRemontowy: facts.monthlyCosts.funduszRemontowy,
					advance: facts.monthlyCosts.advance,
					mediaIncluded: facts.monthlyCosts.mediaIncluded,
					agencyFeePct: facts.monthlyCosts.agencyFeePct,
				}
			: null,
	};
	return hasContent(scored) ? scored : null;
}

/** Ids per query: SQLite's bound-parameter limit is ~900, so stay well under. */
const ID_CHUNK = 500;

/**
 * Load the parsed facts for the given listings. Ids without a row (or with a
 * row that no longer parses) are simply absent from the map. Never throws on
 * a malformed row.
 */
export async function loadScoredFacts(
	ids: readonly number[],
): Promise<Map<number, ScoredFacts>> {
	const wanted = [
		...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
	];
	const out = new Map<number, ScoredFacts>();
	if (wanted.length === 0) return out;
	const { db } = await import("#/db/index");
	for (let start = 0; start < wanted.length; start += ID_CHUNK) {
		const chunk = wanted.slice(start, start + ID_CHUNK);
		const rows = await db
			.select({
				listingId: listingFacts.listingId,
				factsJson: listingFacts.factsJson,
			})
			.from(listingFacts)
			.where(inArray(listingFacts.listingId, chunk));
		for (const row of rows) {
			try {
				const parsed: unknown = JSON.parse(row.factsJson);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					continue;
				}
				const facts = scoredFactsOf(parsed as Record<string, unknown>);
				if (facts) out.set(row.listingId, facts);
			} catch {
				// A corrupt row is skipped, not fatal for the batch.
			}
		}
	}
	return out;
}
