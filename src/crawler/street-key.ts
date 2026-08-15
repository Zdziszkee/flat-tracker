/**
 * Canonical street-name key used by the address parser, the local OSM
 * street index, and the Krakow street lexicon. Keep this in one place so a
 * mined "ul. Karmelickiej" and the lexicon's "Karmelicka" key alike.
 */
export function streetKey(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
