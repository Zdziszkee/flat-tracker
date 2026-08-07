/**
 * Address parsing helpers for feeds that carry street names but no
 * coordinates (morizon, gratka, domiporta, nieruchomosci-online).
 */

/** Extract "Street 12" from free text like "ul. Jakuba Bojki 12/5, Kraków". */
export function parseAddressFromText(
	text: string | null | undefined,
): { street: string; number?: string } | null {
	if (!text) return null;
	const m = text.match(
		/(?:ul\.?|al\.?|aleja|os\.?|osiedle|pl\.?|rynek)?\s*([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż .'-]{1,60}?)\s*(\d{1,4}[A-Za-z]?)?(?:\/\d+)?(?:[,\s]|$)/iu,
	);
	if (!m) return null;
	const street = m[1].trim().replace(/\s+/g, " ");
	// Heuristic: the match must look like a street (not a sentence fragment):
	// at least 2 chars, not a stopword, and ideally followed by a number or
	// at the start of a line.
	if (street.length < 2) return null;
	if (
		/^(na|w|z|do|przy|dla|bez|nowe|mieszkanie|sprzedaż|oferta)$/iu.test(street)
	)
		return null;
	return { street, number: m[2] ?? undefined };
}

/** Build a geocodable address string, e.g. "Jakuba Bojki 12, Kraków". */
export function formatAddressForGeocode(
	street: string,
	number?: string,
	district?: string | null,
): string {
	const streetPart = number ? `${street} ${number}` : street;
	return [streetPart, district, "Kraków"].filter(Boolean).join(", ");
}
