/**
 * Cross-source visibility rule for `/api/listings`.
 *
 * The rule used to run in the route for every request: load all ~47k rows,
 * drop hidden sources, collapse investmap stand-ins, hide rynekpierwotny
 * projects covered by investmap, and dedupe the shared morizon/gratka feed.
 * That is now computed once per crawl by `recomputeListingDerived` and stored
 * as `listings.isVisible`, while this module stays the single, testable
 * definition of the rule. Pure on purpose: no DB and no time dependency.
 */

import { HIDDEN_SOURCES } from "#/crawler/hidden-sources";
import { parseListingFeatures } from "./listing-features";

export interface VisibilityRow {
	id: number;
	source: string;
	externalId: string;
	title: string;
	address: string | null;
	features: string | null;
	price?: number | null;
	areaM2?: number | null;
	rooms?: number | null;
	district?: string | null;
}

/** Normalize a string for cross-source matching: lowercase, no diacritics,
 * alphanumerics only, single spaces. */
export function normKey(value: string): string {
	return value
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const STREET_PREFIXES = /^(ul|al|pl|os|skr|bulw|aleja|bulwar|osiedle)\s+/;

/** Split "Meiera 70, Prądnik Biały" into normalized street + housenumber
 * ("meiera", "70"). Returns null when no street is present. */
export function parseStreetNumber(address: string | null): {
	street: string;
	number: string | null;
} | null {
	if (!address) return null;
	const first = address.split(",")[0] ?? "";
	const keyed = normKey(first);
	const street = keyed
		.replace(STREET_PREFIXES, "")
		.replace(/\s*\d+[a-z]?(?:\s+[a-z]?\d+[a-z]?)*$/, "")
		.trim();
	if (!street) return null;
	const numMatch = keyed.match(/\d+[a-z]?(?:\s+[a-z]?\d+[a-z]?)*$/);
	// Number key collapses separators: "6a, 6b" -> "6a6b".
	const number = numMatch
		? numMatch[0].replace(/[\s/,]/g, "").toLowerCase()
		: null;
	return { street, number };
}

/**
 * Ids of the rows the UI should show. Input order matters: callers pass rows
 * newest first (`scrapedAt desc`), which is what the old route pipeline did.
 */
export function visibleListingIds(rows: readonly VisibilityRow[]): Set<number> {
	const notHidden = rows.filter((row) => !HIDDEN_SOURCES.has(row.source));

	// Investmap investment-level rows (`inv-<id>`) stand in for the
	// investment until its flats appear: once any flat row carries the same
	// features.investment_id, the flat rows are the representation and the
	// stand-in goes away.
	const investmapFlatIds = new Set<string>();
	const investmapFlatTitles = new Set<string>();
	for (const row of notHidden) {
		if (row.source !== "investmap" || row.externalId.startsWith("inv-")) {
			continue;
		}
		// The adapter prefixes every flat title with the investment name and
		// a dash; the title link also covers legacy rows whose features
		// predate the investment_id marker.
		investmapFlatTitles.add(row.title.split(" — ")[0] ?? "");
		const features = parseListingFeatures(row.features);
		const investmentId = features.investmap?.investmentId;
		if (investmentId) investmapFlatIds.add(investmentId);
	}
	const visibleRows = notHidden.filter(
		(row) =>
			!(
				row.source === "investmap" &&
				row.externalId.startsWith("inv-") &&
				(investmapFlatIds.has(row.externalId.slice("inv-".length)) ||
					investmapFlatTitles.has(row.title))
			),
	);

	// Investmap covers rynekpierwotny investments with per-flat detail.
	const investmapRows = visibleRows.filter((row) => row.source === "investmap");
	const rpStreetsWithNumber = new Set<string>();
	const rpStreetsOnly = new Set<string>();
	const rpTitles = new Set<string>();
	for (const row of investmapRows) {
		const address = parseStreetNumber(row.address);
		if (address?.street && address.number) {
			rpStreetsWithNumber.add(`${address.street}|${address.number}`);
			rpStreetsOnly.add(address.street);
		} else if (address?.street) {
			rpStreetsOnly.add(address.street);
		}
		const title = normKey(row.title.split("—")[0] ?? "");
		if (title) rpTitles.add(title);
	}
	const coveredByInvestmap = (row: VisibilityRow): boolean => {
		if (row.source !== "rynekpierwotny") return false;
		const address = parseStreetNumber(row.address);
		if (address?.street && address.number) {
			if (rpStreetsWithNumber.has(`${address.street}|${address.number}`)) {
				return true;
			}
		} else if (address?.street && rpStreetsOnly.has(address.street)) {
			return true;
		}
		return rpTitles.has(normKey(row.title));
	};

	// Morizon and Gratka share the same feed; keep morizon, drop its gratka
	// duplicate.
	const seen = new Set<string>();
	const visible = new Set<number>();
	for (const row of visibleRows) {
		if (coveredByInvestmap(row)) continue;
		// Same tuple the old route used. It is global on purpose: a gratka
		// row is dropped when any earlier row (in practice its morizon twin)
		// has the same price/area/rooms/district.
		const dedupeKey = [
			row.price ?? "",
			row.areaM2 ?? "",
			row.rooms ?? "",
			row.district ?? "",
		].join("|");
		if (row.source === "morizon") {
			seen.add(dedupeKey);
			visible.add(row.id);
			continue;
		}
		if (row.source === "gratka" && seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		visible.add(row.id);
	}
	return visible;
}
