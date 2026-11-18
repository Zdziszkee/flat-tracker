/**
 * Typed readers over the extra facts prompt v2 extracts from prose.
 *
 * `listing_facts.facts_json` holds the whole answer, including fields the
 * listing table has no column for (plot utilities, road access, defects,
 * monthly costs, the setting around a plot). Scoring and valuation should
 * not parse that JSON themselves: this module owns the shape and gives them
 * small, named projections.
 *
 * The readers are synchronous and memoized in-process. A scoring run calls
 * `preloadListingFacts(ids)` once (one chunked query), then every projection
 * is a map lookup; `clearFactCache()` at the start of a run makes a changed
 * corpus visible to a long-lived process.
 *
 * Pure projections (`...Of(facts)`) are exported next to the id-based
 * readers so `validate:facts` can pin the rules without a database, and so
 * a caller that already holds the facts never touches the cache.
 */
import { inArray } from "drizzle-orm";

import { listingFacts } from "#/db/schema";
import {
	type FactContext,
	type ListingFacts,
	type MonthlyCosts,
	normalizeFacts,
	type PlotUtilities,
} from "./listing-facts.ts";

const factCache = new Map<number, ListingFacts | null>();

/** Drop every memoized row. Call at the start of a scoring/valuation run. */
export function clearFactCache(): void {
	factCache.clear();
}

/** Rows currently memoized (loaded or explicitly absent). */
export function factCacheSize(): number {
	return factCache.size;
}

/** Parse a stored `facts_json` value; malformed JSON yields null. */
export function parseFactsJson(
	json: string | null | undefined,
): ListingFacts | null {
	if (!json) return null;
	try {
		return normalizeFacts(JSON.parse(json));
	} catch {
		return null;
	}
}

/**
 * Load facts for the given listing ids in chunks. Ids without a row are
 * memoized as null so a second preload does not query them again.
 * Returns how many ids were newly looked up.
 */
export async function preloadListingFacts(
	ids: readonly number[],
): Promise<number> {
	const wanted = [
		...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
	];
	const missing = wanted.filter((id) => !factCache.has(id));
	if (missing.length === 0) return 0;
	const { db } = await import("#/db/index");
	for (let start = 0; start < missing.length; start += 500) {
		const chunk = missing.slice(start, start + 500);
		const rows = await db
			.select({
				listingId: listingFacts.listingId,
				factsJson: listingFacts.factsJson,
			})
			.from(listingFacts)
			.where(inArray(listingFacts.listingId, chunk));
		const found = new Set<number>();
		for (const row of rows) {
			found.add(row.listingId);
			factCache.set(row.listingId, parseFactsJson(row.factsJson));
		}
		for (const id of chunk) {
			if (!found.has(id)) factCache.set(id, null);
		}
	}
	return missing.length;
}

/** Memoized facts for one listing, or null when absent/not preloaded. */
export function factsFor(id: number): ListingFacts | null {
	return factCache.get(id) ?? null;
}

/** Whether `preloadListingFacts` has already seen this id. */
export function factsLoaded(id: number): boolean {
	return factCache.has(id);
}

// --- Plot media ---------------------------------------------------------

export interface PlotMediaFacts {
	power: boolean | null;
	water: boolean | null;
	gas: boolean | null;
	sewer: boolean | null;
	internet: boolean | null;
	/** Utilities the text says are connected (true, not unknown). */
	connectedCount: number;
	anyConnected: boolean;
	/** Power + water + (sewer or gas): the usual "media pełne" claim. */
	coreConnected: boolean;
}

export function plotMediaOf(
	facts: ListingFacts | null | undefined,
): PlotMediaFacts {
	const utilities: PlotUtilities | null = facts?.utilities ?? null;
	const flags = [
		utilities?.power,
		utilities?.water,
		utilities?.gas,
		utilities?.sewer,
		utilities?.internet,
	];
	const connectedCount = flags.filter((flag) => flag === true).length;
	return {
		power: utilities?.power ?? null,
		water: utilities?.water ?? null,
		gas: utilities?.gas ?? null,
		sewer: utilities?.sewer ?? null,
		internet: utilities?.internet ?? null,
		connectedCount,
		anyConnected: connectedCount > 0,
		coreConnected:
			utilities?.power === true &&
			utilities?.water === true &&
			(utilities?.sewer === true || utilities?.gas === true),
	};
}

export function plotMediaFacts(id: number): PlotMediaFacts {
	return plotMediaOf(factsFor(id));
}

// --- Plot access and buildability --------------------------------------

const ACCESS_ROADS = new Set(["asphalt", "paved", "gravel"]);

export interface PlotAccessFacts {
	roadAccess: string | null;
	roadPublic: boolean | null;
	mpzpSymbol: string | null;
	mpzpPurpose: string | null;
	buildingPermitWz: boolean | null;
	plotShape: string | null;
	plotDimensions: string | null;
	plotSlope: string | null;
	fencing: boolean | null;
	mediaConnected: boolean;
	hasPublicAccess: boolean;
	hasPlanEvidence: boolean;
	/** Any LLM evidence that the parcel can be built on. */
	buildableEvidence: boolean;
}

export function plotAccessOf(
	facts: ListingFacts | null | undefined,
): PlotAccessFacts {
	const roadAccess = facts?.roadAccess ?? null;
	const roadPublic = facts?.roadPublic ?? null;
	const mediaConnected = plotMediaOf(facts).anyConnected;
	const hasPublicAccess =
		roadPublic === true ||
		(roadPublic !== false &&
			roadAccess != null &&
			ACCESS_ROADS.has(roadAccess));
	const hasPlanEvidence =
		facts?.buildingPermitWz === true ||
		(facts?.mpzpSymbol != null && facts.mpzpSymbol.length > 0) ||
		facts?.mpzpPurpose != null;
	return {
		roadAccess,
		roadPublic,
		mpzpSymbol: facts?.mpzpSymbol ?? null,
		mpzpPurpose: facts?.mpzpPurpose ?? null,
		buildingPermitWz: facts?.buildingPermitWz ?? null,
		plotShape: facts?.plotShape ?? null,
		plotDimensions: facts?.plotDimensions ?? null,
		plotSlope: facts?.plotSlope ?? null,
		fencing: facts?.fencing ?? null,
		mediaConnected,
		hasPublicAccess,
		hasPlanEvidence,
		buildableEvidence: mediaConnected || hasPublicAccess || hasPlanEvidence,
	};
}

export function plotAccessFacts(id: number): PlotAccessFacts {
	return plotAccessOf(factsFor(id));
}

// --- Condition / quality signals ---------------------------------------

export interface ConditionSignals {
	condition: string | null;
	buildingType: string | null;
	buildingMaterial: string | null;
	buildYear: number | null;
	technology: string | null;
	insulation: boolean | null;
	windows: string | null;
	floorHeating: boolean | null;
	heatPump: boolean | null;
	recuperation: boolean | null;
	ac: boolean | null;
	pv: boolean | null;
	kitchen: string | null;
	exposure: string | null;
	legalStatus: string | null;
	tenanted: boolean | null;
	monthlyCosts: MonthlyCosts | null;
	defects: string[];
	encumbrances: string[];
	defectCount: number;
}

export function conditionOf(
	facts: ListingFacts | null | undefined,
): ConditionSignals {
	const defects = facts?.defects ?? [];
	const encumbrances = facts?.encumbrances ?? [];
	return {
		condition: facts?.condition ?? null,
		buildingType: facts?.buildingType ?? null,
		buildingMaterial: facts?.buildingMaterial ?? null,
		buildYear: facts?.buildYear ?? null,
		technology: facts?.technology ?? null,
		insulation: facts?.insulation ?? null,
		windows: facts?.windows ?? null,
		floorHeating: facts?.floorHeating ?? null,
		heatPump: facts?.heatPump ?? null,
		recuperation: facts?.recuperation ?? null,
		ac: facts?.ac ?? null,
		pv: facts?.pv ?? null,
		kitchen: facts?.kitchen ?? null,
		exposure: facts?.exposure ?? null,
		legalStatus: facts?.legalStatus ?? null,
		tenanted: facts?.tenanted ?? null,
		monthlyCosts: facts?.monthlyCosts ?? null,
		defects,
		encumbrances,
		defectCount: defects.length + encumbrances.length,
	};
}

export function conditionSignals(id: number): ConditionSignals {
	return conditionOf(factsFor(id));
}

/** Named risks for the "Ryzyka" line: defects first, then encumbrances. */
export function defectListOf(facts: ListingFacts | null | undefined): string[] {
	return [...(facts?.defects ?? []), ...(facts?.encumbrances ?? [])];
}

export function defectList(id: number): string[] {
	return defectListOf(factsFor(id));
}

/** Exact monthly costs when the ad quotes them. */
export function monthlyCostOf(
	facts: ListingFacts | null | undefined,
): MonthlyCosts | null {
	return facts?.monthlyCosts ?? null;
}

export function monthlyCostFacts(id: number): MonthlyCosts | null {
	return monthlyCostOf(factsFor(id));
}

// --- Setting around a plot or house ------------------------------------

export interface ContextFacts {
	lake: boolean | null;
	river: boolean | null;
	forest: boolean | null;
	mountains: boolean | null;
	view: boolean | null;
	/** Number of settings the text explicitly affirms. */
	settingCount: number;
	hasSetting: boolean;
}

export function contextOf(
	facts: ListingFacts | null | undefined,
): ContextFacts {
	const context: FactContext | null = facts?.context ?? null;
	const flags = [
		context?.lake,
		context?.river,
		context?.forest,
		context?.mountains,
		context?.view,
	];
	const settingCount = flags.filter((flag) => flag === true).length;
	return {
		lake: context?.lake ?? null,
		river: context?.river ?? null,
		forest: context?.forest ?? null,
		mountains: context?.mountains ?? null,
		view: context?.view ?? null,
		settingCount,
		hasSetting: settingCount > 0,
	};
}

export function contextFacts(id: number): ContextFacts {
	return contextOf(factsFor(id));
}
