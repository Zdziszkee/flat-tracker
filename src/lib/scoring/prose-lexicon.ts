/**
 * Last-resort reading of the ad text for the two facts the flat gate depends
 * on: the heating source and the building style.
 *
 * The model (`src/lib/llm/`) is the primary prose reader and the structured
 * portal columns come first whenever they exist. This module exists for the
 * rows where both are silent, and it is deliberately narrow: only explicit
 * phrases match ("ogrzewanie miejskie", "piec gazowy", "mieszkanie w bloku",
 * "kamienica"), a negated mention is rejected, and a phrase about something
 * else never counts. It never guesses a source from a hint ("ogrzewanie
 * podłogowe" alone, "CO", "stare budownictwo").
 *
 * Every hit is reported as `prose`, below `column`, `features` and `facts`, so
 * a stored portal value or a model answer always wins and a lexicon match is
 * auditable on the card.
 */

/**
 * Explicit heating statements. `ogrzewanie` may be followed by a qualifier
 * ("niezależne", "podłogowe", "własne") before the source, which is why the
 * gap is allowed; the source itself must always be named.
 */
const HEATING_PATTERNS: Array<{ kind: string; re: RegExp }> = [
	{
		kind: "district",
		re: /ogrzewani\w*[^.;,]{0,20}(?:miejsk|osiedlow|sieciow)\w*|(?:z\s+)?sieci\s+miejsk\w*|ciep[łl]o\s+systemow\w*|energi\w*\s+ciepln\w*\s+z\s+sieci|\bmpec\b|\bc\.?o\.?\s+miejsk\w*/iu,
	},
	{
		kind: "heatPump",
		re: /pomp\w*\s+ciep[łl]a/iu,
	},
	{
		kind: "gas",
		re: /ogrzewani\w*[^.;,]{0,20}gazow\w*|piec\w*\s+gazow\w*|kocio[łl]\w*\s+gazow\w*|kot[łl]owni\w*\s+gazow\w*/iu,
	},
	{
		kind: "electric",
		re: /ogrzewani\w*[^.;,]{0,20}elektryczn\w*|grzejnik\w*\s+elektryczn\w*|piec\w*\s+akumulacyjn\w*|mat\w*\s+grzewcz\w*|kabl\w*\s+grzewcz\w*/iu,
	},
	{
		kind: "coalWood",
		re: /ogrzewani\w*[^.;,]{0,20}(?:w[ęe]glow\w*|drewn\w*|drzew\w*)|piec\w*\s+(?:w[ęe]glow\w*|kaflow\w*)|kominek\w*\s+(?:z\s+p[łl]aszczem|w\s+salonie)|ekogroszek/iu,
	},
	{
		kind: "oil",
		re: /ogrzewani\w*[^.;,]{0,20}olejow\w*|piec\w*\s+olejow\w*/iu,
	},
];

/** A phrase negated right before it ("bez ogrzewania miejskiego") is not a fact. */
const NEGATION =
	/\b(?:bez|brak|nie|nie\s+posiada|pozbawion\w*|zamiast)\b[^.;,]{0,25}$/iu;

/**
 * The heating source the ad states explicitly, as the `heating` vocabulary the
 * extractor and the column use, or null when the text does not say.
 */
export function heatingFromProse(
	text: string | null | undefined,
): string | null {
	if (!text) return null;
	const flat = text.replace(/\s+/gu, " ");
	for (const { kind, re } of HEATING_PATTERNS) {
		const match = re.exec(flat);
		if (!match) continue;
		const before = flat.slice(Math.max(0, match.index - 60), match.index);
		if (NEGATION.test(before)) continue;
		return kind;
	}
	return null;
}

/**
 * Building style stated in passing: "sprzedam mieszkanie w bloku",
 * "kamieniczka z 1928", "apartamentowiec", "wielka płyta". A large-panel
 * mention wins over the generic block, a tenement over both, because it is the
 * more specific statement.
 */
const PANEL =
	/wielk\w*\s+p[łl]yt\w*|wielkop[łl]yt\w*|p[łl]yt\w*\s+prefabrykowan\w*|prefabryk\w*/iu;
const TENEMENT = /kamienic\w*|kamieniczk\w*/iu;
const APARTMENT = /apartamentowiec|wie[żz]owiec|wysoko[śs]ciowiec/iu;
const BLOCK = /\bw\s+bloku\b|\bblok(?:u|iem|i|ów)?\b/iu;

export function buildingStyleFromProse(
	text: string | null | undefined,
): "tenement" | "largePanel" | "block" | "apartment" | null {
	if (!text) return null;
	const flat = text.replace(/\s+/gu, " ");
	const negated = (index: number) =>
		NEGATION.test(flat.slice(Math.max(0, index - 60), index));

	if (TENEMENT.test(flat)) {
		const match = TENEMENT.exec(flat);
		if (match && !negated(match.index)) return "tenement";
	}
	if (PANEL.test(flat)) {
		const match = PANEL.exec(flat);
		if (match && !negated(match.index)) return "largePanel";
	}
	if (APARTMENT.test(flat)) {
		const match = APARTMENT.exec(flat);
		if (match && !negated(match.index)) return "apartment";
	}
	const block = BLOCK.exec(flat);
	if (block && !negated(block.index)) return "block";
	return null;
}
