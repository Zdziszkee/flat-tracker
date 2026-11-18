/**
 * The ad text as the pipeline stores and reads it.
 *
 * Every offer is stored with its whole title and description: the description
 * is the only place most portals state heating, building style, condition,
 * plot media and the legal situation, and the fact extractor reads exactly
 * what is stored. A per-adapter slice used to cut this at 2 000 chars, which
 * threw away the paragraph that carried the fact; the single cap here is a
 * safety valve against a pathological page (a scraped HTML fragment loop), not
 * a summarization window.
 *
 * `DESCRIPTION_MAX_CHARS` and the model's prompt window are the same number,
 * so the stored text, the hashed text and the text the model reads are one
 * payload: an unchanged offer is never re-sent, and a fact the model saw is
 * reproducible from the database.
 */
export const DESCRIPTION_MAX_CHARS = 20_000;

/** Collapse whitespace and enforce the one storage/prompt cap. */
export function clipDescription(
	description: string | null | undefined,
): string | null {
	if (!description) return null;
	const text = description.replace(/\s+/gu, " ").trim();
	if (!text) return null;
	return text.slice(0, DESCRIPTION_MAX_CHARS);
}
