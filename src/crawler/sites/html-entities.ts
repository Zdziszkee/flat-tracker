/**
 * Decode the HTML entities that portal JSON blobs carry when their own
 * backend stores already-escaped text (gethome descriptions use `&oacute;`
 * and friends). The adapters do not have a DOM for these strings, and the
 * project does not depend on an entity package directly, so this covers the
 * entities Polish real-estate copy actually uses plus numeric escapes.
 */
const NAMED: Record<string, string> = {
	amp: "&",
	apos: "'",
	quot: '"',
	lt: "<",
	gt: ">",
	nbsp: " ",
	hellip: "…",
	ndash: "–",
	mdash: "—",
	oacute: "ó",
	Oacute: "Ó",
	aacute: "á",
	Aacute: "Á",
	eacute: "é",
	Eacute: "É",
	iacute: "í",
	Iacute: "Í",
	uacute: "ú",
	Uacute: "Ú",
	lstroke: "ł",
	Lstroke: "Ł",
	oelig: "œ",
	OElig: "Œ",
	sacute: "ś",
	Sacute: "Ś",
	zacute: "ź",
	Zacute: "Ź",
	zdotaccent: "ż",
	Zdotaccent: "Ż",
	ccedil: "ç",
	Ccedil: "Ç",
	szlig: "ß",
};

export function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
			const code = Number.parseInt(hex, 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : "";
		})
		.replace(/&#(\d+);/g, (_, dec: string) => {
			const code = Number.parseInt(dec, 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : "";
		})
		.replace(/&([a-z][a-z0-9]+);/gi, (match, name: string) => {
			return NAMED[name] ?? match;
		});
}

/** Collapse whitespace and strip a trailing "zł"/"m²" unit when present. */
export function cleanText(value: string | null | undefined): string | null {
	if (!value) return null;
	const text = decodeHtmlEntities(value).replace(/\s+/g, " ").trim();
	return text || null;
}
