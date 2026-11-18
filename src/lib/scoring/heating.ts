/**
 * Heating evidence for offer scoring.
 *
 * Portals almost never publish a structured heating field for the bulk
 * sources: of ~11.6k visible flats only a few hundred carry
 * `listings.heating_type`, and the otodom detail attribute
 * (`features.heating = "urban" | "gas" | ...`) covers only detail-crawled
 * rows because the CDN rate-limits bulk detail fetches. Most sellers do
 * state the heating in the description ("ogrzewanie miejskie", "MPEC",
 * "piec gazowy"), so the classifier reads all three sources and returns one
 * kind plus the phrase it matched. The matched phrase is what the property
 * component scores, so a description claim and a structured attribute are
 * weighted identically.
 *
 * The classifier never guesses: nothing found means `unknown`, which fails
 * the municipal-heating gate rather than counting as a pass.
 */
import { HEATING_DELTAS } from "./config";

export type HeatingKind =
	| "district"
	| "heatPump"
	| "gas"
	| "electric"
	| "coalWood"
	| "oil"
	| "unknown";

export type HeatingSource = "column" | "features" | "description" | "none";

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
 * Free-text patterns, most specific first. Prose mentions are matched with
 * a negation guard below, so "bez ogrzewania miejskiego" cannot pass as
 * municipal heating.
 */
const TEXT_PATTERNS: ReadonlyArray<readonly [HeatingKind, RegExp]> = [
	["heatPump", /pomp\S*\s*ciep[łl]a|\bheat[ _-]?pump/iu],
	[
		"district",
		/\bmpec\b|ciep[łl]o\s+systemowe|systemowe\s+ciep[łl]o|sie[ćc]\s+miejska|miejsk\w*\s+sie[ćc]\s+ciep[łl]ownicz|miejskie\s+ogrzewanie|ogrzewanie[\s:–-]+(?:z\s+)?(?:sieci\s+)?miejsk|do\s+sieci\s+miejskiej|z\s+sieci\s+miejskiej|elektrociep[łl]own|district[ _-]?heating|\burban\b/iu,
	],
	[
		"electric",
		/ogrzewanie\s+elektryczn|elektryczn\w*\s+ogrzewanie|grzejnik\w*\s+elektryczn|\belectric(?:al)?\b/iu,
	],
	[
		"gas",
		/ogrzewanie\s+gazow|piec\s+gazow|kocio[łl]\w*\s+gazow|gazow\w*\s+ogrzewanie|\bgas\b/iu,
	],
	[
		"coalWood",
		/ogrzewanie\s+w[ęe]glow|piec\s+w[ęe]glow|kocio[łl]\w*\s+w[ęe]glow|kominek|drewn\w*|\bcoal\b|\bwood\b/iu,
	],
	["oil", /olejow\w*|\boil\b/iu],
];

/** Structured values are short codes or labels, so the match stays loose. */
function kindFromValue(value: string): HeatingKind {
	const text = value.toLowerCase();
	if (/pompa|heat[ _-]?pump/u.test(text)) return "heatPump";
	if (/miejsk|urban|district|sie[ćc]|c\.?o\./u.test(text)) return "district";
	if (/elektr|electric/u.test(text)) return "electric";
	if (/gaz|gas/u.test(text)) return "gas";
	if (/w[ęe]g|coal|drewno|wood/u.test(text)) return "coalWood";
	if (/olej|oil/u.test(text)) return "oil";
	return "unknown";
}

const NEGATION = /(?:^|\W)(?:bez|brak|nie\s+ma|niedost[ęe]pn\w*)\s*$/iu;

/**
 * First positive mention in prose. A negated mention ("brak ogrzewania
 * miejskiego") is skipped, not counted either way: it rules district
 * heating out but does not prove a different kind.
 */
export function heatingKindFromText(
	text: string,
): { kind: HeatingKind; text: string } | null {
	const haystack = text.toLowerCase();
	for (const [kind, pattern] of TEXT_PATTERNS) {
		const global = new RegExp(pattern.source, "giu");
		for (const match of haystack.matchAll(global)) {
			const index = match.index ?? 0;
			const before = haystack.slice(Math.max(0, index - 24), index);
			if (NEGATION.test(before)) continue;
			return { kind, text: match[0] };
		}
	}
	return null;
}

export interface HeatingSources {
	heatingType?: string | null;
	featuresHeating?: string | null;
	title?: string | null;
	description?: string | null;
}

/**
 * Resolve one kind from the structured column, the portal attribute blob and
 * the prose, in that order of authority.
 */
export function resolveHeatingEvidence(
	sources: HeatingSources,
): HeatingEvidence {
	const structured = sources.heatingType?.trim();
	if (structured) {
		const kind = kindFromValue(structured);
		return {
			kind,
			text: structured,
			source: "column",
			delta: KIND_DELTA[kind],
		};
	}
	const attribute = sources.featuresHeating?.trim();
	if (attribute) {
		const kind = kindFromValue(attribute);
		return {
			kind,
			text: attribute,
			source: "features",
			delta: KIND_DELTA[kind],
		};
	}
	const prose = `${sources.title ?? ""}\n${sources.description ?? ""}`;
	const match = heatingKindFromText(prose);
	if (match) {
		return {
			kind: match.kind,
			text: match.text,
			source: "description",
			delta: KIND_DELTA[match.kind],
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
