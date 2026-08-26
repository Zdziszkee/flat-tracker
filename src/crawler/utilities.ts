/**
 * Rental utility/administrative fee parsing.
 *
 * Rental listings often carry an additional monthly "czynsz" (administration
 * fee) plus utilities (heating, electricity, water, gas, garbage). We parse
 * whatever the description mentions and store it as a JSON string in
 * `listings.utilities`.
 *
 * Parsing rules learned from real ads:
 * - A keyword and its amount must sit on the SAME line ("prąd: wg zużycia"
 *   must not swallow the next line's "kaucja: 4000").
 * - "czynsz najmu: X" states the RENT, not an extra fee — skipped. A bare
 *   "czynsz: X" whose amount equals the listing price is also the rent.
 * - Explicit admin phrasing wins: "opłaty administracyjne", "czynsz
 *   administracyjny", "czynsz dodatkowo", "eksploatacyjne".
 * - Deposit lines (kaucja/depozyt/zagwarantowany) are never fees.
 */

interface UtilitiesInfo {
	czynsz: number | null;
	ogrzewanie: number | null;
	prad: number | null;
	woda: number | null;
	gaz: number | null;
	smieci: number | null;
	text?: string | null;
}

/** Amount with optional space-grouped thousands and a currency suffix. */
const AMOUNT =
	/(\d{1,3}(?:[ \u00a0]\d{3})+|\d{2,6})(?:[.,]\d{1,2})?\s*(?:zł|zl\b|pln\b)/i;

const KEYWORDS: Array<[keyof UtilitiesInfo, RegExp]> = [
	["ogrzewanie", /\bogrzewanie\b|\bogrzew\.\b|(?:\bco\b)/i],
	["prad", /\bpr[ąa]d\b|\bprad\b/i],
	["woda", /\bwoda\b|\bwody\b/i],
	["gaz", /\bgaz\b/i],
	["smieci", /[śs]mieci/i],
];

/** Phrases that mark a czynsz amount as the EXTRA administrative fee. */
const CZYNSZ_ADMIN =
	/(?:op[łl]at\w*|czynsz|koszt\w*)[^.:!\n]{0,24}(?:administracyjn\w*|eksploatacyjn\w*)|czynsz[^.:!\n]{0,12}dodatkow\w*/i;

/** "czynsz najmu" / "czynsz za najem" = the rent itself. */
const CZYNSZ_RENT =
	/czynsz[^.:!\n]{0,12}(?:najmu|za\s+najem|najmu\s+w\s+wysoko)/i;

const DEPOSIT = /\bkaucj\w*|\bdepozyt\w*|\bzagwarantowan\w*|\bcaution\b/i;

function amountAfter(text: string, from: number): number | null {
	const raw = text.slice(from, from + 60);
	// Amounts belong to their own line: never read past a line break
	// ("prąd: wg zużycia" must not swallow "kaucja: 4000" below it).
	const window = raw.includes("\n") ? raw.slice(0, raw.indexOf("\n")) : raw;
	const m = AMOUNT.exec(window);
	if (!m) return null;
	const n = Number(m[1].replace(/[ \u00a0]/g, "").replace(",", "."));
	return Number.isFinite(n) && n >= 20 && n <= 20000 ? n : null;
}

function findAmount(lines: string[], re: RegExp): number | null {
	for (const line of lines) {
		if (DEPOSIT.test(line)) continue;
		const m = re.exec(line);
		if (!m) continue;
		const value = amountAfter(line, m.index + m[0].length);
		if (value != null) return value;
	}
	return null;
}

/**
 * Extract utility/fee amounts from a description. `rent` (the listing's
 * advertised price, when known) lets us discard "czynsz" lines that merely
 * restate the rent. Returns JSON or null when nothing was found.
 */
export function parseUtilities(
	text: string | null | undefined,
	rent?: number | null,
): string | null {
	if (!text) return null;
	// HTML descriptions become one plain-text token stream; tags act as
	// line breaks so bullets ("- czynsz najmu: 3490 zł") stay self-contained.
	const plain = text.replace(/<[^>]+>/g, "\n");
	const lines = plain.split(/\r?\n/);

	const out: Record<string, unknown> = {};

	// Pass 1: explicit administrative phrases win, wherever they sit
	// ("czynsz administracyjny w wysokości około 780 zł" inside one long
	// sentence must beat an earlier generic "na opłaty" anchor).
	let czynsz: number | null = null;
	const adminRe =
		/(?:czynsz|op[łl]at\w*|koszt\w*)[^.:!\n]{0,30}?(?:administracyjn\w*|eksploatacyjn\w*)/gi;
	let am: RegExpExecArray | null;
	while ((am = adminRe.exec(plain)) !== null) {
		if (CZYNSZ_RENT.test(am[0])) continue;
		const value = amountAfter(plain, am.index + am[0].length);
		if (value != null) {
			czynsz = value;
			break;
		}
	}

	// Pass 2 (fallback): any czynsz/opłaty anchor, skipping rent phrasing
	// and amounts that merely restate the listing price.
	if (czynsz == null) {
		for (const line of lines) {
			if (DEPOSIT.test(line)) continue;
			if (!/\bczynsz\b|\bop[łl]at/i.test(line)) continue;
			const m = /\bczynsz\b|\bop[łl]at\w*/i.exec(line);
			if (!m) continue;
			const value = amountAfter(line, m.index + m[0].length);
			if (value == null) continue;
			if (CZYNSZ_RENT.test(line)) continue;
			if (CZYNSZ_ADMIN.test(line)) {
				czynsz = value;
				break;
			}
			// Bare "czynsz 3490" when the listing costs 3490 = restating the rent.
			if (rent != null && Math.abs(value - rent) < 1) continue;
			czynsz ??= value;
		}
	}
	out.czynsz = czynsz;

	for (const [key, re] of KEYWORDS) {
		out[key] = findAmount(lines, re);
	}

	const found = Object.values(out).some((v) => v != null);
	if (!found) return null;
	out.text = plain.replace(/\s+/g, " ").trim().slice(0, 240);
	return JSON.stringify(out);
}
