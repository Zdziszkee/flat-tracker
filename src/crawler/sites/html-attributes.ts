/**
 * Harvest every labelled value a detail page prints, without a selector per
 * portal.
 *
 * The adapters parse the fields the app models (price, area, rooms, heating),
 * but the portals print far more in structures the parsers never touch: a
 * definition list of "Rodzaj ogrzewania / Rok budowy / Materiał", a two-column
 * table of costs, a list of "Media: prąd, woda", a row of chips. Those values
 * were read by a human and dropped by the crawler.
 *
 * This collector walks the label/value shapes that cover most of them
 * (`dl`, two- and four-cell table rows, list items and rows whose label ends
 * with a colon, `[data-label]` blocks) and returns a flat `label -> value` map
 * that the adapter merges into `features`, where `attributes.ts` promotes the
 * known labels (its aliases already cover the Polish names) and the rest stays
 * inspectable in the record panel.
 *
 * Deliberately conservative: labels up to 48 characters, values up to 240,
 * at most `limit` entries, first value wins, and no text is invented from a
 * bare paragraph (a page is full of prose that is not a fact).
 */
import * as cheerio from "cheerio";

const LABEL_MAX = 40;
const VALUE_MAX = 120;
/** Labels with more words than this are a sentence, not a field. */
const LABEL_WORDS_MAX = 6;
const DEFAULT_LIMIT = 150;

/** Labels that are page furniture, not offer facts. */
const SKIP_LABEL =
	/^(?:menu|nawigacja|logowanie|rejestracja|stopka|copyright|udost[eę]pnij|drukuj|powr[oó]t|strona g[łl][oó]wna|oferty|o nas|regulamin|polityka|cookies|zaloguj|newsletter|obserwuj|facebook|instagram|youtube|u[żz]ytkownik\w*|ods[łl]on\w*|aktualn\w*\s+og[łl]osze\w*|kontakt\w*|kredyt\w*)$/iu;

function clean(text: string): string {
	return text
		.replace(/\u00a0/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function labelOf(text: string): string {
	return clean(text).replace(/[:\s]+$/u, "");
}

export function harvestDetailAttributes(
	html: string,
	limit = DEFAULT_LIMIT,
): Record<string, string> {
	const $ = cheerio.load(html);
	const out: Record<string, string> = {};
	const add = (labelText: string, valueText: string): boolean => {
		if (Object.keys(out).length >= limit) return false;
		const label = labelOf(labelText);
		const value = clean(valueText);
		if (!label || !value) return true;
		if (label.length > LABEL_MAX || value.length > VALUE_MAX) return true;
		if (label.split(" ").length > LABEL_WORDS_MAX) return true;
		if (SKIP_LABEL.test(label)) return true;
		if (label in out) return true;
		out[label] = value;
		return true;
	};

	// Definition lists: <dt>label</dt><dd>value</dd> (also nested in dl.dl-horizontal).
	$("dl").each((_, dl) => {
		const $dl = $(dl);
		$dl.find("dt").each((_, dt) => {
			const $dt = $(dt);
			const $dd = $dt.next("dd");
			if ($dd.length > 0) add($dt.text(), $dd.first().text());
		});
	});

	// Two-column table rows, and four-column rows that hold two pairs.
	$("table tr").each((_, tr) => {
		const cells = $(tr)
			.children("th,td")
			.filter((_, cell) => clean($(cell).text()).length > 0);
		if (cells.length === 2) {
			add(cells.eq(0).text(), cells.eq(1).text());
			return;
		}
		if (cells.length === 4) {
			add(cells.eq(0).text(), cells.eq(1).text());
			add(cells.eq(2).text(), cells.eq(3).text());
		}
	});

	// "Rodzaj ogrzewania: miejskie" — a row whose label cell ends with a colon.
	$("li, p, div").each((_, node) => {
		if (Object.keys(out).length >= limit) return false;
		const $node = $(node);
		// Only leaf-ish rows: a container would swallow the whole page. Page
		// furniture (footer, nav, promo banners) is marketing copy, not facts.
		if ($node.find("li, table, dl").length > 0) return true;
		if (
			$node.closest(
				'footer, header, nav, aside, [class*="promo"], [class*="banner"], [class*="footer"]',
			).length > 0
		) {
			return true;
		}
		const text = clean($node.text());
		const match = text.match(/^([^:]{2,60}):\s*(.+)$/u);
		if (match) add(match[1], match[2]);
		return true;
	});

	// Chips and rows that carry the label in an attribute.
	$("[data-label], [data-name]").each((_, node) => {
		if (Object.keys(out).length >= limit) return false;
		const $node = $(node);
		const label = $node.attr("data-label") ?? $node.attr("data-name") ?? "";
		const value =
			$node.attr("data-value") ?? clean($node.text()).replace(clean(label), "");
		if (label) add(label, value);
		return true;
	});

	return out;
}

/**
 * Merge a harvest into the adapter's own `features` object: the parsed fields
 * win (they are typed and tested), the harvest only adds labels nobody read.
 */
export function withHarvestedAttributes(
	features: Record<string, unknown>,
	html: string,
): Record<string, unknown> {
	const harvested = harvestDetailAttributes(html);
	const seen = new Set(
		Object.keys(features).map((key) =>
			key
				.normalize("NFD")
				.replace(/\p{Diacritic}/gu, "")
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "_"),
		),
	);
	const merged: Record<string, unknown> = { ...features };
	for (const [label, value] of Object.entries(harvested)) {
		const key = label
			.normalize("NFD")
			.replace(/\p{Diacritic}/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "");
		if (!key || seen.has(key)) continue;
		seen.add(key);
		merged[key] = value;
	}
	return merged;
}
