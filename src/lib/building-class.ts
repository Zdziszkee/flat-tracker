/**
 * The building a flat or house sits in, as a buyer reads it.
 *
 * Portals label almost everything "blok" or "apartament", while buyers
 * distinguish a pre-war kamienica, an old block (wielka płyta or anything built
 * before 2000), a new block and a purpose-built apartment building. The class
 * is derived once from the strongest evidence available: the model's reading
 * of the ad text (a tenement, a large-panel block), then the structured
 * columns (building type, material, build year).
 *
 * The alert gate uses `oldBlock`: only old blocks are excluded. A tenement, a
 * new block, an apartment building and a block whose age nobody stated are
 * eligible, and the card states which one it is (or that it is unknown).
 */

export type BuildingClassKind =
	| "tenement"
	| "oldBlock"
	| "newBlock"
	| "block"
	| "apartment"
	| "house"
	| "unknown";

export interface BuildingClassInfo {
	kind: BuildingClassKind;
	/** Polish label for the card: "kamienica", "stary blok", ... */
	label: string;
	/** What decided it ("rok budowy 1998", "z opisu", "dane portalu"), or null. */
	evidence: string | null;
	/** True only when the building is *proved* to be an old block. */
	oldBlock: boolean;
}

/** A block built before this year counts as an old block. */
export const NEW_BLOCK_MIN_YEAR = 2000;
/** Pre-war buildings are treated as kamienice even when labelled otherwise. */
export const TENEMENT_MAX_YEAR = 1945;

export interface BuildingClassInput {
	buildingType?: string | null;
	buildingMaterial?: string | null;
	buildYear?: number | null;
	/** "apartment"/"flat"/"house"/"plot"; plots have no building class. */
	propertyKind?: string | null;
	/** The model's reading of the ad text. */
	facts?: {
		buildingStyle?: string | null;
		buildYear?: number | null;
		technology?: string | null;
	} | null;
}

const UNKNOWN: BuildingClassInfo = {
	kind: "unknown",
	label: "nieznany",
	evidence: null,
	oldBlock: false,
};

function houseLabel(text: string): string | null {
	if (/bli[żz]niak|semi[ _-]?detached/u.test(text)) return "bliźniak";
	if (/szeregowiec|townhouse|segment/u.test(text)) return "szeregowiec";
	if (/wolnostoj|detached|\bdom\b/u.test(text)) return "dom";
	return null;
}

export function buildingClassOf(input: BuildingClassInput): BuildingClassInfo {
	const kindHint = (input.propertyKind ?? "").toLowerCase();
	if (kindHint === "plot") return UNKNOWN;

	const text = `${input.buildingType ?? ""} ${input.buildingMaterial ?? ""}`
		.toLowerCase()
		.trim();
	const style = (input.facts?.buildingStyle ?? "").toLowerCase();
	const technology = (input.facts?.technology ?? "").toLowerCase();
	const year = input.buildYear ?? input.facts?.buildYear ?? null;
	const yearEvidence = year != null ? `rok budowy ${year}` : null;
	const fromFacts = yearEvidence == null ? "z opisu" : yearEvidence;

	// Houses are their own segment; the class only names them.
	const house =
		style === "house" || kindHint === "house"
			? (houseLabel(text) ?? "dom")
			: houseLabel(text);
	if (house) {
		return {
			kind: "house",
			label: house,
			evidence: fromFacts,
			oldBlock: false,
		};
	}

	const panel =
		style === "largepanel" ||
		/wielka[ _-]?p[łl]yta|wielkop[łl]yt|panel|prefab/u.test(text) ||
		/prefab/u.test(technology);
	if (panel) {
		return {
			kind: "oldBlock",
			label: "stary blok (wielka płyta)",
			evidence: fromFacts,
			oldBlock: true,
		};
	}

	const tenement =
		style === "tenement" ||
		/kamienic|tenement/u.test(text) ||
		(year != null && year <= TENEMENT_MAX_YEAR);
	if (tenement) {
		return {
			kind: "tenement",
			label: "kamienica",
			evidence: fromFacts,
			oldBlock: false,
		};
	}

	const apartment =
		style === "apartment" || /apartamentowiec|apartment/u.test(text);
	if (apartment) {
		return {
			kind: "apartment",
			label: "apartamentowiec",
			evidence: fromFacts,
			oldBlock: false,
		};
	}

	const block = style === "block" || /blok|block|wie[żz]owiec/u.test(text);
	if (block && year != null) {
		if (year >= NEW_BLOCK_MIN_YEAR) {
			return {
				kind: "newBlock",
				label: "nowy blok",
				evidence: yearEvidence,
				oldBlock: false,
			};
		}
		return {
			kind: "oldBlock",
			label: "stary blok",
			evidence: yearEvidence,
			oldBlock: true,
		};
	}
	if (block) {
		return {
			kind: "block",
			label: "blok (rok nieznany)",
			evidence: fromFacts,
			oldBlock: false,
		};
	}

	return UNKNOWN;
}
