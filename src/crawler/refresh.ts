import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { max, sql } from "drizzle-orm";
import { Effect } from "effect";

import { db } from "#/db/index";
import { listings } from "#/db/schema";
import { pruneOldListings, recordCrawlRun } from "./db-sink.ts";
import { geocodeUnlocatedListings } from "./geocode-listings.ts";
import { importRcn } from "./import-rcn.ts";
import { runCrawlWithRetry } from "./pipeline.ts";
import { adapters } from "./sites/index.ts";
import type { SiteAdapter } from "./types.ts";

/**
 * Full data refresh: crawl every real listing portal, prune stale
 * otodom/olx offers, then apply the incremental RCN diff (a HEAD check
 * skips the 2 GB download when the registry hasn't changed).
 *
 * This is the same program as `npm run crawl:all`, exposed as a callable
 * so the Nitro server can run it on dev startup and on an hourly schedule
 * without spawning CLI processes. Portal failures are isolated per site:
 * one blocked portal does not abort the rest of the run.
 *
 * Dev-start runs use `diffOnly`: each site's since window is bounded to
 * `sinceDays` (7) AND rolled forward to the last successful crawl of that
 * site, so a boot only fetches what the portals added since the previous
 * load.
 */

/** Demo adapters that must never hit real portal traffic. */
const DEMO_SITES = new Set(["quotes", "books"]);

const DEFAULT_SINCE_DAYS = 90;
/** Dev-start diff window: never go further back than this. */
export const DEV_SINCE_DAYS = 7;

const STATE_PATH = "data/crawler/state.json";

export interface SiteRefresh {
	site: string;
	ok: boolean;
	newListings: number;
	updatedListings: number;
	pages: number;
	elapsedSeconds: number;
	error?: string;
}

export interface RefreshSummary {
	sites: SiteRefresh[];
	/** otodom/olx offers older than the since window, removed after the crawl. */
	pruned: number;
	/** NEW transactions inserted by the RCN diff (0 when the registry is unchanged). */
	rcnNew: number;
	/** Listings anchored on the map this run (local index + Nominatim). */
	geocoded: number;
	startedAt: string;
	elapsedSeconds: number;
}

type CrawlState = Record<string, string>;

async function readState(): Promise<CrawlState> {
	try {
		return JSON.parse(await readFile(STATE_PATH, "utf8")) as CrawlState;
	} catch {
		return {};
	}
}

async function writeState(state: CrawlState): Promise<void> {
	await mkdir(dirname(STATE_PATH), { recursive: true });
	await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

export async function refreshAll(
	opts: { sinceDays?: number; diffOnly?: boolean; includeRcn?: boolean } = {},
): Promise<RefreshSummary> {
	const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
	const now = Date.now();
	const started = now;
	const state = await readState();

	// The newest "added" date already stored per source. Dev-start diffs use
	// this as the per-site anchor, so a boot fetches only what the DB is
	// missing instead of re-downloading the whole window.
	const latestRows = await db
		.select({
			source: listings.source,
			latest: max(
				sql<number>`coalesce(${listings.listedAt}, ${listings.firstSeenAt})`,
			),
		})
		.from(listings)
		.groupBy(listings.source);
	const latestBySource = new Map(
		latestRows
			.filter((r) => r.latest != null)
			.map((r) => [r.source, Number(r.latest) * 1000] as const),
	);

	// Scrape all sites in parallel; portal failures stay isolated per site.
	const siteAdapters = adapters.filter((base) => !DEMO_SITES.has(base.id));
	const tasks = siteAdapters.map(async (base): Promise<SiteRefresh> => {
		const last = state[base.id] ? Date.parse(state[base.id]) : NaN;
		const dbLatest = latestBySource.get(base.id) ?? 0;
		const sinceMs = opts.diffOnly
			? Math.max(
					now - sinceDays * 24 * 60 * 60 * 1000,
					dbLatest,
					Number.isNaN(last) ? 0 : last,
				)
			: now - sinceDays * 24 * 60 * 60 * 1000;
		// Clamp at "now" so a stray future-dated row never freezes the diff.
		const since = new Date(Math.min(now, sinceMs));
		// A per-run clone carries the date window; only list-paginating
		// sites (otodom, olx, licytacje-komornik) use it, the rest ignore it.
		const adapter: SiteAdapter = { ...base, since: since.toISOString() };
		const taskStarted = Date.now();
		try {
			const report = await Effect.runPromise(runCrawlWithRetry(adapter, true));
			await recordCrawlRun({
				source: adapter.id,
				startedAt: new Date(taskStarted),
				finishedAt: new Date(),
				pages: report.pages,
				newCount: report.newListings,
				updatedCount: report.updatedListings,
			});
			return {
				site: adapter.id,
				ok: true,
				newListings: report.newListings,
				updatedListings: report.updatedListings,
				pages: report.pages,
				elapsedSeconds: report.elapsedSeconds,
			};
		} catch (err) {
			console.error(`[refresh] crawl of "${adapter.id}" failed:`, err);
			await recordCrawlRun({
				source: adapter.id,
				startedAt: new Date(taskStarted),
				finishedAt: new Date(),
				pages: 0,
				newCount: 0,
				updatedCount: 0,
				error: String(err),
			});
			return {
				site: adapter.id,
				ok: false,
				newListings: 0,
				updatedListings: 0,
				pages: 0,
				elapsedSeconds: 0,
				error: String(err),
			};
		}
	});

	// Run the site tasks with bounded concurrency: enough to be parallel
	// across portals, but not so many crawlers at once that MemoryStorage /
	// Playwright blow the process memory budget.
	const SITE_CONCURRENCY = 3;
	const sites: SiteRefresh[] = new Array(tasks.length);
	let nextTask = 0;
	async function worker() {
		while (nextTask < tasks.length) {
			const i = nextTask++;
			try {
				sites[i] = await tasks[i];
			} catch (err) {
				sites[i] = {
					site: siteAdapters[i]?.id ?? "unknown",
					ok: false,
					newListings: 0,
					updatedListings: 0,
					pages: 0,
					elapsedSeconds: 0,
					error: String(err),
				};
			}
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(SITE_CONCURRENCY, tasks.length) }, () =>
			worker(),
		),
	);

	for (const s of sites) {
		if (s.ok) state[s.site] = new Date().toISOString();
	}
	await writeState(state);

	const pruned = await pruneOldListings(
		new Date(now - sinceDays * 24 * 60 * 60 * 1000),
	);
	// Anchor new offers on the map: local OSM-index matches are instant,
	// Nominatim is budgeted (20/run) so the hourly cron drains the backlog
	// politely. Run `npm run geocode-addresses` for a full drain.
	const geo = await geocodeUnlocatedListings({ nominatimLimit: 20 });
	const rcnNew = opts.includeRcn === false ? 0 : await importRcn();

	return {
		sites,
		pruned,
		rcnNew,
		geocoded: geo.localHits + geo.nomHits,
		startedAt: new Date(started).toISOString(),
		elapsedSeconds: (Date.now() - started) / 1000,
	};
}
