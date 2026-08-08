import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";

import { pruneOldListings } from "./db-sink.ts";
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

	const sites: SiteRefresh[] = [];
	for (const base of adapters) {
		if (DEMO_SITES.has(base.id)) continue;
		// Dev-start diff: since = max(now - sinceDays, last successful crawl)
		// per site, so only offers added since the previous load are fetched.
		const last = state[base.id] ? Date.parse(state[base.id]) : NaN;
		const sinceMs = opts.diffOnly
			? Math.max(
					now - sinceDays * 24 * 60 * 60 * 1000,
					Number.isNaN(last) ? 0 : last,
				)
			: now - sinceDays * 24 * 60 * 60 * 1000;
		const since = new Date(sinceMs);
		// A per-run clone carries the date window; only list-paginating
		// sites (otodom, olx, licytacje-komornik) use it, the rest ignore it.
		const adapter: SiteAdapter = { ...base, since: since.toISOString() };
		try {
			const report = await Effect.runPromise(runCrawlWithRetry(adapter, true));
			sites.push({
				site: adapter.id,
				ok: true,
				newListings: report.newListings,
				updatedListings: report.updatedListings,
				pages: report.pages,
				elapsedSeconds: report.elapsedSeconds,
			});
			state[adapter.id] = new Date().toISOString();
			await writeState(state);
		} catch (err) {
			console.error(`[refresh] crawl of "${adapter.id}" failed:`, err);
			sites.push({
				site: adapter.id,
				ok: false,
				newListings: 0,
				updatedListings: 0,
				pages: 0,
				elapsedSeconds: 0,
				error: String(err),
			});
		}
	}

	const pruned = await pruneOldListings(
		new Date(now - sinceDays * 24 * 60 * 60 * 1000),
	);
	const rcnNew = opts.includeRcn === false ? 0 : await importRcn();

	return {
		sites,
		pruned,
		rcnNew,
		startedAt: new Date(started).toISOString(),
		elapsedSeconds: (Date.now() - started) / 1000,
	};
}
