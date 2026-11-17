/**
 * Lenient text parsers shared by the portal adapters.
 *
 * Polish portals render the same facts in card text ("1 250 000 zł",
 * "48,5 m²", "3 pokoje"), so the number and href readers live here instead
 * of being copied into every adapter.
 */

/** "1 250 000" / "48,5" / "3" -> number; null when nothing numeric. */
export function parseNumberText(
	value: string | null | undefined,
): number | null {
	if (!value) return null;
	const n = Number.parseFloat(
		value.replace(/[\s\u00a0]/g, "").replace(",", "."),
	);
	return Number.isFinite(n) ? n : null;
}

/** Asking price from a card's text ("1 250 000 zł"); spaces are separators. */
export function priceFromText(text: string): number | null {
	return parseNumberText(text.match(/([\d\s\u00a0]+)\s*zł/iu)?.[1]);
}

/** Floor area from free text ("48,5 m²"). */
export function areaFromText(text: string): number | null {
	return parseNumberText(text.match(/([\d\s.,]+)\s*m[²2]/iu)?.[1]);
}

/** Resolve a card's href against the portal base; null for junk hrefs. */
export function absoluteUrl(
	href: string | null | undefined,
	base: string,
): string | null {
	if (!href) return null;
	try {
		return new URL(href, base).href;
	} catch {
		return null;
	}
}

/** Numeric value of one query parameter (pagination), or null. */
export function pageParamNumber(url: string, param: string): number | null {
	const match = url.match(new RegExp(`[?&]${param}=(\\d+)`));
	return match ? Number.parseInt(match[1], 10) : null;
}
