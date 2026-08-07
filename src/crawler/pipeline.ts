import { Data, Effect, Schedule, Schema } from "effect";

import { crawlSite } from "./crawler.ts";
import { saveListings } from "./db-sink.ts";
import type { SiteAdapter } from "./types.ts";

/**
 * Effect-based orchestration layer for the crawler.
 *
 * The crawl pipeline is modelled as an Effect program: failures are typed
 * (`CrawlError`), retries are driven by schedules, and listings are
 * validated against an Effect Schema before persistence.
 */

export class CrawlError extends Data.TaggedError("CrawlError")<{
	site: string;
	cause: unknown;
}> {}

/** Effect Schema for the output of a crawl run. */
export const ListingSchema = Schema.Struct({
	source: Schema.String,
	externalId: Schema.String,
	url: Schema.String,
	title: Schema.String,
	price: Schema.Union(Schema.Number, Schema.Null),
	pricePerM2: Schema.Union(Schema.Number, Schema.Null),
	areaM2: Schema.Union(Schema.Number, Schema.Null),
	rooms: Schema.Union(Schema.Number, Schema.Null),
	floor: Schema.Union(Schema.String, Schema.Null),
	district: Schema.Union(Schema.String, Schema.Null),
	lat: Schema.Union(Schema.Number, Schema.Null),
	lng: Schema.Union(Schema.Number, Schema.Null),
	listedAt: Schema.Union(Schema.String, Schema.Null),
	scrapedAt: Schema.String,
});

export const ListingArraySchema = Schema.Array(ListingSchema);

export interface CrawlReport {
	site: string;
	listings: number;
	pages: number;
	inserted: number;
	elapsedSeconds: number;
}

/** Crawl one site, persist the listings, and report. */
export const runCrawl = (
	adapter: SiteAdapter,
	saveToDb: boolean,
): Effect.Effect<CrawlReport, CrawlError> =>
	Effect.gen(function* () {
		const started = Date.now();

		const result = yield* Effect.tryPromise({
			try: () => crawlSite(adapter),
			catch: (cause) => new CrawlError({ site: adapter.id, cause }),
		});

		// Validate what the adapter produced before persisting.
		const validated = yield* Effect.tryPromise({
			try: () => {
				const decoded = Schema.decodeUnknownSync(ListingArraySchema)(
					result.listings,
				);
				return Promise.resolve(decoded);
			},
			catch: (cause) => new CrawlError({ site: adapter.id, cause }),
		});

		const inserted = saveToDb ? yield* saveEffect(adapter.id, validated) : 0;

		return {
			site: adapter.id,
			listings: validated.length,
			pages: result.pages,
			inserted,
			elapsedSeconds: (Date.now() - started) / 1000,
		};
	});

const saveEffect = (
	site: string,
	list: readonly import("./types.ts").Listing[],
): Effect.Effect<number, CrawlError> =>
	Effect.tryPromise({
		try: () => saveListings([...list]),
		catch: (cause) => new CrawlError({ site, cause }),
	});

/**
 * Same as runCrawl but wrapped in an exponential-backoff retry schedule.
 * Useful for scheduled cron-style runs where a transient portal block
 * should not fail the whole job.
 */
export const runCrawlWithRetry = (
	adapter: SiteAdapter,
	saveToDb: boolean,
): Effect.Effect<CrawlReport, CrawlError> => {
	const policy = Schedule.exponential("1 seconds", 2).pipe(
		Schedule.compose(Schedule.recurs(3)),
	);
	return Effect.retry(runCrawl(adapter, saveToDb), policy);
};
