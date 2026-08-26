/**
 * Rental utility/administrative fee parsing and estimation.
 *
 * Rental listings often carry an additional monthly "czynsz" (administration
 * fee) plus utilities (heating, electricity, water, gas, garbage). We parse
 * whatever the description mentions and store it as a JSON string in
 * `listings.utilities`, then estimate missing values from similar listings.
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

const KEYWORDS: Array<[keyof UtilitiesInfo, RegExp]> = [
	["czynsz", /czynsz(?:[^0-9]{0,50}?)(\d{2,5})(?:\s*[.,]\s*\d{1,2})?\s*zł/iu],
	[
		"ogrzewanie",
		/ogrzewanie(?:[^0-9]{0,50}?)(\d{2,5})(?:\s*[.,]\s*\d{1,2})?\s*zł/iu,
	],
	["prad", /pr[ąa]d(?:[^0-9]{0,50}?)(\d{2,5})(?:\s*[.,]\s*\d{1,2})?\s*zł/iu],
	["woda", /woda(?:[^0-9]{0,50}?)(\d{2,5})(?:\s*[.,]\s*\d{1,2})?\s*zł/iu],
	["gaz", /gaz(?:[^0-9]{0,50}?)(\d{2,5})(?:\s*[.,]\s*\d{1,2})?\s*zł/iu],
	[
		"smieci",
		/[śs]mieci(?:[^0-9]{0,50}?)(\d{2,5})(?:\s*[.,]\s*\d{1,2})?\s*zł/iu,
	],
];

function parseAmount(m: RegExpExecArray | null): number | null {
	if (!m) return null;
	const n = Number(m[1].replace(/\s/g, "").replace(",", "."));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/** Extract utility/fee amounts from a description. Returns JSON or null. */
export function parseUtilities(text: string | null | undefined): string | null {
	if (!text) return null;
	const out: Record<string, unknown> = {};
	let found = false;
	for (const [key, re] of KEYWORDS) {
		const value = parseAmount(re.exec(text));
		out[key] = value;
		if (value != null) found = true;
	}
	if (!found) return null;
	out.text = text.slice(0, 240);
	return JSON.stringify(out);
}
