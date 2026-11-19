/**
 * Heating evidence for offer scoring.
 *
 * Portals almost never publish a heating field for the bulk sources: of
 * ~11.6k visible flats only a few hundred carry `listings.heating_type`, and
 * the otodom detail attribute (`features.heating = "urban" | "gas" | ...`)
 * covers only detail-crawled rows because the CDN rate-limits bulk detail
 * fetches. The descriptions do state it ("ogrzewanie miejskie", "MPEC",
 * "piec gazowy"), but prose is read by the LLM fact extractor
 * (`src/lib/llm/`), not by regexes here: a pattern list produced false
 * positives ("bez ogrzewania miejskiego", "w sąsiedztwie miejskiego basenu")
 * and could not tell a heat pump mention from a recommendation to install one.
 *
 * Resolution order, most authoritative first:
 *   1. `listings.heating_type` (portal detail attribute, or the LLM value the
 *      extractor promoted into the column)
 *   2. `features.heating` (portal attribute blob)
 *   3. the LLM's `heating` fact for this listing, read straight from
 *      `listing_facts` so a row the column promotion has not reached yet still
 *      counts
 *   4. the narrow prose lexicon (`prose-lexicon.ts`), for the rows where the
 *      model has not run or answered nothing: an explicitly stated source
 *      ("ogrzewanie miejskie", "piec gazowy") still counts, a negated or
 *      ambiguous mention does not
 * Nothing found means `unknown`, which fails the municipal-heating gate rather
 * than counting as a pass.
 */
import { HEATING_DELTAS } from "./config";
import { heatingFromProse } from "./prose-lexicon";

export type HeatingKind =
	| "district"
	| "heatPump"
	| "gas"
	| "electric"
	| "coalWood"
	| "oil"
	| "unknown";

export type HeatingSource = "column" | "features" | "facts" | "prose" | "none";

export interface HeatingEvidence {
	kind: HeatingKind;
	/** The phrase (or raw structured value) that matched, null when unknown. */
	text: string | null;
	source: HeatingSource;
	/** Points the property component adds for this kind. */
	delta: number;
}

const KIND_DELTA: Record<HeatingKind, number> = {
	district: HEATING_DELTAS.district,
	heatPump: HEATING_DELTAS.heatPump,
	gas: HEATING_DELTAS.gas,
	electric: HEATING_DELTAS.electric,
	coalWood: HEATING_DELTAS.coalWood,
	oil: HEATING_DELTAS.oil,
	unknown: 0,
};

/**
 * Structured values are short portal codes, human labels or the extractor's
 * enum names, so the match stays loose. `district` covers "miejskie", "MPEC",
 * "sieć miejska", the English "urban"/"district", the extractor's
 * `district`, and the Polish enum aliases it normalizes to.
 */
export function heatingKindFromValue(value: string): HeatingKind {
	const text = value.toLowerCase();
	if (/pompa|heat[ _-]?pump/u.test(text)) return "heatPump";
	if (
		/miejsk|urban|district|sie[ćc]\s*miejsk|mpec|systemow|c\.?o\./u.test(text)
	) {
		return "district";
	}
	if (/elektr|electric/u.test(text)) return "electric";
	if (/gaz|gas/u.test(text)) return "gas";
	if (/w[ęe]g|coal|drewno|wood|kominek/u.test(text)) return "coalWood";
	if (/olej|oil/u.test(text)) return "oil";
	return "unknown";
}

export interface HeatingSources {
	heatingType?: string | null;
	featuresHeating?: string | null;
	/** LLM-extracted heating fact (`listing_facts.facts_json.heating`). */
	factsHeating?: string | null;
	/** Title and description, read only for an explicitly stated source. */
	prose?: string | null;
}

/**
 * Resolve one kind from the structured column, the portal attribute blob and
 * the LLM fact, in that order of authority. The first non-empty source wins,
 * even when it resolves to `unknown`: a portal field that says "none" must not
 * be overridden by a model reading of the ad text.
 */
export function resolveHeatingEvidence(
	sources: HeatingSources,
): HeatingEvidence {
	const structured = sources.heatingType?.trim();
	if (structured) {
		const kind = heatingKindFromValue(structured);
		return {
			kind,
			text: structured,
			source: "column",
			delta: KIND_DELTA[kind],
		};
	}
	const attribute = sources.featuresHeating?.trim();
	if (attribute) {
		const kind = heatingKindFromValue(attribute);
		return {
			kind,
			text: attribute,
			source: "features",
			delta: KIND_DELTA[kind],
		};
	}
	const fact = sources.factsHeating?.trim();
	if (fact) {
		const kind = heatingKindFromValue(fact);
		return { kind, text: fact, source: "facts", delta: KIND_DELTA[kind] };
	}
	const prose = heatingFromProse(sources.prose);
	if (prose) {
		const kind = heatingKindFromValue(prose);
		return {
			kind,
			text: prose,
			source: "prose",
			delta: KIND_DELTA[kind],
		};
	}
	return { kind: "unknown", text: null, source: "none", delta: 0 };
}

export const HEATING_LABELS: Record<HeatingKind, string> = {
	district: "miejskie",
	heatPump: "pompa ciepła",
	gas: "gazowe",
	electric: "elektryczne",
	coalWood: "węglowe / drewno",
	oil: "olejowe",
	unknown: "nieznane",
};
