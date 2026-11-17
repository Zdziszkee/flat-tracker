/**
 * Embedded page-state readers for adapters whose feed is a JS assignment.
 *
 * Some portals ship their full search payload as
 * `window.__INITIAL_STATE__ = {...};` inside a `<script>` tag. The object is
 * followed by more JavaScript, so it must be cut at its matching brace
 * rather than at the last brace in the snippet. gethome and rynekpierwotny
 * read the same shape; this module keeps one parser for both.
 */

/** Extract the first balanced {...} object from a JS snippet. */
function extractBalancedObject(raw: string): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
		} else if (c === "{") {
			depth++;
		} else if (c === "}") {
			depth--;
			if (depth === 0) return raw.slice(0, i + 1);
		}
	}
	return null;
}

/**
 * Parse the object assigned to `marker` (default `window.__INITIAL_STATE__`)
 * in the page HTML. Returns null when the marker, the object or its JSON is
 * missing; callers treat that as an empty page.
 */
export function parseWindowState<T>(
	html: string,
	marker = "__INITIAL_STATE__",
): T | null {
	const at = html.indexOf(marker);
	if (at < 0) return null;
	const eq = html.indexOf("=", at);
	if (eq < 0) return null;
	const raw = html.slice(eq + 1).trimStart();
	const json = extractBalancedObject(raw);
	if (!json) return null;
	try {
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}
