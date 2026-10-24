/**
 * City-level flat price reference from finwire.pl.
 *
 * NBP's BaRN database is the official external reference for residential
 * prices, but its public pages sit behind a WAF that no plain HTTP client
 * gets past. finwire.pl publishes the same kind of measure straight from the
 * Rejestr Cen Nieruchomości (RCN): a 12-quarter median zł/m² series per city,
 * embedded as an Angular `ng-state` JSON blob on `/ceny-mieszkan/<city>`.
 *
 * We import the two tracked cities (Kraków, Katowice) into `price_indices`
 * as `external_city` rows, `method = "external"`, `source = "finwire"`.
 * `rebuildPriceIndices()` deletes only `source = "rcn"`, so these survive a
 * local rebuild. The valuation model uses them as a last-resort fallback
 * when neither the district nor the grid10 nor the regional RCN series has
 * enough points for a flat comparable.
 *
 * The data is RCN-derived and city-wide: it is a trend reference for flats
 * only, never a price level for houses or plots, and never a substitute for
 * a real building-level comparable. The quarterly medians are converted to a
 * chain index (first usable quarter = 100), which is the shape
 * `timeAdjustment()` consumes.
 *
 * Cadence: weekly, gated by `data/crawler/finwire-state.json`; the hourly
 * refresh calls this and it skips inside the window. `--force` refreshes now.
 */

import { eq } from "drizzle-orm";

import { db } from "#/db/index";
import { priceIndices } from "#/db/schema";
import { readJsonFile, writeJsonFile } from "#/lib/json-state";
import { EXTERNAL_CITIES } from "#/lib/valuation/external-city";
import {
	chainCityTrend,
	type FinwireCityData,
	parseFinwireCityPage,
} from "#/lib/valuation/finwire-trend";
import type { ValuationSegment } from "#/lib/valuation/price-index";

type FinwireCity = (typeof EXTERNAL_CITIES)[number];

const STATE_PATH = "data/crawler/finwire-state.json";
const REFRESH_DAYS = 7;
const SOURCE = "finwire";

/** City-level series are flat-only; primary/secondary fall back to it. */
const SEGMENTS: readonly ValuationSegment[] = [
	"flat",
	"flat_primary",
	"flat_secondary",
];

export interface FinwireImportResult {
	skipped: boolean;
	cities: number;
	rows: number;
	skippedCities: string[];
}

function stateIsFresh(lastImportedAt: string | null): boolean {
	if (!lastImportedAt) return false;
	return Date.now() - Date.parse(lastImportedAt) < REFRESH_DAYS * 86_400_000;
}

function rowsForCity(
	city: FinwireCity,
	data: FinwireCityData,
): Array<typeof priceIndices.$inferInsert> {
	const chained = chainCityTrend(data.trend);
	const rows: Array<typeof priceIndices.$inferInsert> = [];
	for (const segment of SEGMENTS) {
		for (const point of chained) {
			rows.push({
				segment,
				geographyType: "external_city",
				// The city slug is the key, not the display name: lookups use
				// the same slug the resolver derives from a comparable.
				geographyKey: city.slug,
				period: point.quarter,
				indexValue: point.indexValue,
				medianPriceM2: point.medianM2,
				sampleCount: point.n,
				strata: null,
				method: "external",
				source: SOURCE,
			});
		}
	}
	return rows;
}

async function fetchCityPage(slug: string): Promise<string> {
	const response = await fetch(`https://finwire.pl/ceny-mieszkan/${slug}`, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (compatible; flat-tracker/1.0; +https://github.com/Zdziszkee/flat-tracker)",
			Accept: "text/html",
		},
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} for finwire/${slug}`);
	}
	return response.text();
}

/**
 * Import the tracked cities' quarterly flat-price trends into
 * `price_indices` as `external_city` rows. The feed is a complete dump per
 * city, so the whole `source = "finwire"` slice is replaced atomically after
 * every fetch: quarters roll out of the 12-quarter window, and a stale row
 * left behind would otherwise keep a comp adjusting against an old quarter.
 */
export async function importFinwire(
	opts: { force?: boolean } = {},
): Promise<FinwireImportResult> {
	const state = await readJsonFile<{ lastImportedAt: string | null }>(
		STATE_PATH,
	);
	if (!opts.force && stateIsFresh(state?.lastImportedAt ?? null)) {
		return { skipped: true, cities: 0, rows: 0, skippedCities: [] };
	}

	const pages = await Promise.allSettled(
		EXTERNAL_CITIES.map(async (city) => ({
			city,
			html: await fetchCityPage(city.slug),
		})),
	);

	const values: Array<typeof priceIndices.$inferInsert> = [];
	const skippedCities: string[] = [];
	let cities = 0;
	pages.forEach((settled, i) => {
		const city = EXTERNAL_CITIES[i] as FinwireCity;
		if (settled.status !== "fulfilled") {
			skippedCities.push(city.slug);
			console.warn(`[finwire] ${city.slug} failed: ${String(settled.reason)}`);
			return;
		}
		const data = parseFinwireCityPage(settled.value.html, city.slug);
		if (!data) {
			skippedCities.push(city.slug);
			console.warn(`[finwire] ${city.slug}: no cm-rcn-city payload`);
			return;
		}
		cities++;
		values.push(...rowsForCity(city, data));
	});

	// Every city failed: keep the previous rows rather than wiping the
	// reference layer over a transient network error.
	if (cities === 0) {
		throw new Error("finwire: no city page could be parsed");
	}

	await db.delete(priceIndices).where(eq(priceIndices.source, SOURCE));
	for (let i = 0; i < values.length; i += 500) {
		await db.insert(priceIndices).values(values.slice(i, i + 500));
	}

	// Only record success when every city landed; a partial run must be
	// retried on the next refresh instead of being gated for a week.
	if (skippedCities.length === 0) {
		await writeJsonFile(STATE_PATH, {
			lastImportedAt: new Date().toISOString(),
			rows: values.length,
		});
	}

	return {
		skipped: false,
		cities,
		rows: values.length,
		skippedCities,
	};
}
