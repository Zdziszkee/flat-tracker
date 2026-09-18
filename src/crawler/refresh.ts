import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { max, sql } from "drizzle-orm";
import { Effect } from "effect";

import { db } from "#/db/index";
import { listings } from "#/db/schema";
import { enrichAirbnbDetails } from "./airbnb-enrich.ts";
import { warnIfBrowserSourcesUnavailable } from "./browser-check.ts";
import { pruneOldListings, recordCrawlRun } from "./db-sink.ts";
import { geocodeUnlocatedListings } from "./geocode-listings.ts";
import { importRcn } from "./import-rcn.ts";
import { runCrawlWithRetry } from "./pipeline.ts";
import {
	beginRefresh,
	endRefresh,
	isRunning,
	setPhase,
	setSourceProgress,
} from "./progress.ts";
import { adapters } from "./sites/index.ts";
import type { SiteAdapter } from "./types.ts";

/**
 * Full data refresh: crawl every real listing portal, prune stale
 * otodom/olx offers, then apply the incremental RCN diff (a HEAD check
 * skips the 2 GB download when the registry hasn't changed).
 *
 * This is the only crawl entry point: it runs inside the Nitro server on
 * dev startup, on an hourly schedule, and when the /sources page triggers
 * a manual refresh via /api/refresh. Portal failures are isolated per
 * site: one blocked portal does not abort the rest of the run.
 *
 * Server runs are first-page-only by default (`firstPageOnly: true`): each
 * site fetches only its first, newest-sorted page and skips pagination and
 * detail follow-ups. `alwaysFullCrawl` opts a source back into full
 * pagination when its newest page is not sufficient for discovery.
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

interface SiteRefresh {
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
	/** NEW transactions from GUGiK per-powiat GeoPackages (region minus Kraków). */
	gugikNew: number;
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
	opts: {
		sinceDays?: number;
		diffOnly?: boolean;
		includeRcn?: boolean;
		/** Airbnb detail-page enrichment (beds/guests/amenities). Default on. */
		includeAirbnbEnrich?: boolean;
		/**
		 * Fetch only the first (newest) page per site. Defaults to true: the
		 * hourly/server refresh is an incremental catch-up.
		 */
		firstPageOnly?: boolean;
	} = {},
): Promise<RefreshSummary> {
	// Single-flight: the hourly task, the dev-boot plugin and the manual
	// /api/refresh button all land here; never overlap crawls in one process.
	if (isRunning()) {
		console.warn("[refresh] already running; skipping concurrent refresh");
		return {
			sites: [],
			pruned: 0,
			rcnNew: 0,
			gugikNew: 0,
			geocoded: 0,
			startedAt: new Date().toISOString(),
			elapsedSeconds: 0,
		};
	}

	// Begin the live-progress registry synchronously so a concurrent caller
	// (hourly task / dev boot / /api/refresh) sees the run immediately.
	const siteAdapters = adapters.filter((base) => !DEMO_SITES.has(base.id));
	beginRefresh([
		...siteAdapters.map((a) => a.id),
		"geocoding",
		"rcn-import",
		"building-assign",
	]);
	// Fresh clone: the npm package ships without browser binaries, so
	// browser-rendered portals would fail with a stack trace each.
	await warnIfBrowserSourcesUnavailable(
		siteAdapters.filter((a) => a.kind === "playwright").map((a) => a.id),
	);

	const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
	const firstPageOnly = opts.firstPageOnly ?? true;
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
	try {
		const tasks = siteAdapters.map((base) => async (): Promise<SiteRefresh> => {
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
			const adapter: SiteAdapter = {
				...base,
				since: since.toISOString(),
				firstPageOnly,
			};
			const taskStarted = Date.now();
			setSourceProgress(base.id, {
				state: "running",
				startedAt: new Date(taskStarted).toISOString(),
			});
			try {
				const report = await Effect.runPromise(
					runCrawlWithRetry(adapter, true),
				);
				await recordCrawlRun({
					source: adapter.id,
					startedAt: new Date(taskStarted),
					finishedAt: new Date(),
					pages: report.pages,
					newCount: report.newListings,
					updatedCount: report.updatedListings,
				});
				setSourceProgress(base.id, {
					state: "ok",
					finishedAt: new Date().toISOString(),
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
				setSourceProgress(base.id, {
					state: "failed",
					finishedAt: new Date().toISOString(),
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
					sites[i] = await tasks[i]();
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
					setSourceProgress(sites[i].site, {
						state: "failed",
						finishedAt: new Date().toISOString(),
						error: String(err),
					});
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

		setPhase("prune");
		const pruned = await pruneOldListings(
			new Date(now - sinceDays * 24 * 60 * 60 * 1000),
		);

		// Airbnb room-page enrichment: bedrooms/beds/bathrooms, guests,
		// amenities for listings captured by the search crawl. Budgeted so
		// the hourly cron drains the backlog politely (~100 pages/run).
		if (opts.includeAirbnbEnrich !== false) {
			setPhase("airbnb-enrich");
			const aT0 = Date.now();
			setSourceProgress("airbnb-enrich", {
				state: "running",
				startedAt: new Date(aT0).toISOString(),
			});
			const enrich = await enrichAirbnbDetails({ limit: 100 });
			await recordCrawlRun({
				source: "airbnb-enrich",
				startedAt: new Date(aT0),
				finishedAt: new Date(),
				pages: enrich.fetched,
				newCount: enrich.enriched,
				updatedCount: 0,
			});
			setSourceProgress("airbnb-enrich", {
				state: "ok",
				finishedAt: new Date().toISOString(),
				newCount: enrich.enriched,
			});
		}

		// Anchor new offers on the map: local OSM-index matches are instant,
		// Nominatim is budgeted (100/run) so the hourly cron drains the backlog
		// politely.
		setPhase("geocode");
		const geoT0 = Date.now();
		setSourceProgress("geocoding", {
			state: "running",
			startedAt: new Date(geoT0).toISOString(),
		});
		const geo = await geocodeUnlocatedListings({ nominatimLimit: 100 });
		const geocoded = geo.localHits + geo.nomHits;
		await recordCrawlRun({
			source: "geocoding",
			startedAt: new Date(geoT0),
			finishedAt: new Date(),
			pages: 0,
			newCount: geocoded,
			updatedCount: geo.titleExtracted,
		});
		setSourceProgress("geocoding", {
			state: "ok",
			finishedAt: new Date().toISOString(),
			newCount: geocoded,
			updatedCount: geo.titleExtracted,
		});

		setPhase("rcn");
		const rcnT0 = Date.now();
		if (opts.includeRcn !== false) {
			setSourceProgress("rcn-import", {
				state: "running",
				startedAt: new Date(rcnT0).toISOString(),
			});
		}
		const rcnNew = opts.includeRcn === false ? 0 : await importRcn();

		// Region-wide price history (all małopolska powiaty except Kraków,
		// which the richer RCN zip above covers): GUGiK "Usługa Transakcje"
		// per-powiat GeoPackages, cadence-gated inside the importer.
		let gugikNew = 0;
		if (opts.includeRcn !== false) {
			const { importRcnGugik } = await import("./import-rcn-gugik.ts");
			gugikNew = await importRcnGugik();
		}

		if (opts.includeRcn !== false) {
			await recordCrawlRun({
				source: "rcn-import",
				startedAt: new Date(rcnT0),
				finishedAt: new Date(),
				pages: 0,
				newCount: rcnNew,
				updatedCount: 0,
			});
			setSourceProgress("rcn-import", {
				state: "ok",
				finishedAt: new Date().toISOString(),
				newCount: rcnNew,
			});
		}

		// New RCN rows land unbound: bind transactions -> buildings (and
		// backfill building addresses) right away so the daily registry diff
		// shows up colored on the map without a manual assign-buildings run.
		if (opts.includeRcn !== false && rcnNew + gugikNew > 0) {
			const { assignBuildings } = await import("./assign-buildings.ts");
			setPhase("building-assign");
			setSourceProgress("building-assign", {
				state: "running",
				startedAt: new Date().toISOString(),
			});
			try {
				const a = await assignBuildings();
				console.log(
					`[refresh] building assignment after RCN diff: ${a.listings} listings, ${a.transactions} transactions, ${a.addressBackfilled} addresses`,
				);
				setSourceProgress("building-assign", {
					state: "ok",
					finishedAt: new Date().toISOString(),
					newCount: a.transactions,
					updatedCount: a.listings,
				});
			} catch (err) {
				setSourceProgress("building-assign", {
					state: "failed",
					error: String(err),
				});
				console.error("[refresh] building assignment failed:", err);
			}
		}

		return {
			sites,
			pruned,
			rcnNew,
			gugikNew,
			geocoded,
			startedAt: new Date(started).toISOString(),
			elapsedSeconds: (Date.now() - started) / 1000,
		};
	} finally {
		endRefresh();
	}
}
