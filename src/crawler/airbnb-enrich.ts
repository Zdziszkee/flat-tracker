/**
 * Airbnb room-page enrichment: fills bedrooms/beds/bathrooms, guest
 * capacity, amenities, rating, description and precise-ish coordinates
 * for listings captured by the search crawl.
 *
 * Shared by the CLI script (scripts/enrich-airbnb.ts, large budgets) and
 * the hourly refresh (small budget that drains the backlog of new rows).
 *
 * Resumable: rows with `max_guests IS NULL` still need a pass
 * (PDP personCapacity is always present, so it doubles as the
 * "enriched" marker); dead listings / pages without usable state are
 * recorded in data/crawler/airbnb-enrich-skip.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { listings } from "../db/schema.ts";
import { parseRoomHtml } from "./sites/airbnb-detail.ts";

const SKIP_FILE = "data/crawler/airbnb-enrich-skip.json";

const HEADERS = {
	"user-agent":
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
	"accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
	accept: "text/html,application/xhtml+xml",
};

export interface EnrichOptions {
	/** Max room pages to fetch this run. */
	limit?: number;
	/** Polite pacing between fetches (ms). */
	delayMs?: number;
	onProgress?: (info: {
		done: number;
		total: number;
		enriched: number;
		dead: number;
		throttled: number;
	}) => void;
}

export interface EnrichReport {
	fetched: number;
	enriched: number;
	dead: number;
	throttled: number;
}

function loadSkip(): Set<string> {
	if (!existsSync(SKIP_FILE)) return new Set();
	try {
		return new Set(JSON.parse(readFileSync(SKIP_FILE, "utf8")) as string[]);
	} catch {
		return new Set();
	}
}

function mergeFeatures(
	oldJson: string | null,
	details: ReturnType<typeof parseRoomHtml>,
): string | null {
	let base: Record<string, unknown> = {};
	if (oldJson) {
		try {
			base = JSON.parse(oldJson) as Record<string, unknown>;
		} catch {
			base = {};
		}
	}
	base.amenities = details?.amenities ?? [];
	base.overviewTitle = details?.overviewTitle ?? null;
	base.locationSubtitle = details?.locationSubtitle ?? null;
	base.isExactLocation = details?.isExactLocation ?? null;
	base.spaceType = details?.spaceType ?? null;
	return JSON.stringify(base);
}

/** null = dead listing (permanent skip); "transient" = retry next run. */
async function fetchRoom(url: string): Promise<string | null | "transient"> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const res = await fetch(url, {
			headers: HEADERS,
			redirect: "follow",
			signal: controller.signal,
		});
		if (res.status === 404 || res.status === 410) return null;
		if (res.status === 403 || res.status === 429) return "transient";
		if (!res.ok) return "transient";
		return await res.text();
	} catch {
		return "transient";
	} finally {
		clearTimeout(timer);
	}
}

export async function enrichAirbnbDetails(
	opts: EnrichOptions = {},
): Promise<EnrichReport> {
	const limit = opts.limit ?? 3000;
	const delayMs = opts.delayMs ?? 250;

	const skip = loadSkip();

	const rows = await db
		.select({
			id: listings.id,
			externalId: listings.externalId,
			url: listings.url,
			features: listings.features,
		})
		.from(listings)
		.where(
			sql`${listings.source} = 'airbnb' AND ${listings.maxGuests} IS NULL AND ${listings.isActive} = 1`,
		);

	const todo = rows.filter((r) => !skip.has(r.externalId));
	const total = Math.min(todo.length, limit);

	const report: EnrichReport = {
		fetched: 0,
		enriched: 0,
		dead: 0,
		throttled: 0,
	};
	let consecutiveTransient = 0;

	for (const row of todo) {
		if (report.fetched >= limit) break;
		const html = await fetchRoom(row.url);
		report.fetched++;
		if (html === "transient") {
			report.throttled++;
			consecutiveTransient++;
			// Wall of blocks: stop the run instead of burning the budget.
			if (consecutiveTransient >= 5) break;
			await new Promise((r) => setTimeout(r, 1000));
			continue;
		}
		consecutiveTransient = 0;

		if (html == null) {
			report.dead++;
			skip.add(row.externalId);
			continue;
		}

		const details = parseRoomHtml(html);
		if (!details || (details.maxGuests == null && details.bedrooms == null)) {
			// No usable state (bot-wall page, layout change): record so we
			// stop burning budget on this one.
			skip.add(row.externalId);
			continue;
		}

		await db
			.update(listings)
			.set({
				maxGuests: sql`coalesce(${details.maxGuests}, ${listings.maxGuests})`,
				bedrooms: sql`coalesce(${details.bedrooms}, ${listings.bedrooms})`,
				beds: sql`coalesce(${details.beds}, ${listings.beds})`,
				bathrooms: sql`coalesce(${details.bathrooms}, ${listings.bathrooms})`,
				rating: sql`coalesce(${details.rating}, ${listings.rating})`,
				reviewsCount: sql`coalesce(${details.reviewsCount}, ${listings.reviewsCount})`,
				propertyType: sql`coalesce(${details.propertyType}, ${listings.propertyType})`,
				description: sql`coalesce(${listings.description}, ${details.descriptionShort ?? details.descriptionLong})`,
				lat: sql`coalesce(${listings.lat}, ${details.lat})`,
				lng: sql`coalesce(${listings.lng}, ${details.lng})`,
				features: mergeFeatures(row.features, details),
			})
			.where(eq(listings.id, row.id));
		report.enriched++;

		if (report.fetched % 50 === 0) {
			writeFileSync(SKIP_FILE, JSON.stringify([...skip]));
			opts.onProgress?.({
				done: report.fetched,
				total,
				enriched: report.enriched,
				dead: report.dead,
				throttled: report.throttled,
			});
		}
		await new Promise((r) => setTimeout(r, delayMs));
	}

	writeFileSync(SKIP_FILE, JSON.stringify([...skip]));
	return report;
}
