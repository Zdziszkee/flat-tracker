/**
 * Batch runner for model-extracted listing facts.
 *
 * Reads sale offers that carry prose, sends them to the model in small
 * batches, stores the answer in `listing_facts` and promotes the facts into
 * the listing columns scoring reads. Only empty columns are filled:
 * a portal-published fact always wins over an interpreted one.
 *
 * Re-runs are cheap and idempotent, and an offer is sent to the model at most
 * once per (text, prompt version). Each stored row keeps a hash of the text it
 * came from, so an unchanged listing is never sent again; a changed title or
 * description is (the hash covers both). An answer that carried no fact is
 * stored as `{}` with the same hash: "the model read this and found nothing"
 * is a result, not a pending row, otherwise a 300/run budget could never drain
 * a backlog of ads that simply state nothing. A batch that fails (transport,
 * unparseable answer) stores nothing and is retried next run.
 *
 * Failure isolation matches the rest of the pipeline: one bad batch is
 * counted and reported, the run continues, and the caller gets the first few
 * error messages with their causes intact.
 */
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingFacts, listings } from "#/db/schema";
import { chatText, llmConfigured, llmModel } from "./client.ts";
import {
	FACT_BATCH_SIZE,
	FACT_PROMPT_VERSION,
	type FactInput,
	type FactKnownRow,
	factBatches,
	factPrompt,
	factRowOutcomes,
	factTextHash,
	type ListingFacts,
	parseFactsAnswer,
	promptDescription,
	selectFactCandidates,
} from "./listing-facts.ts";
export interface ExtractFactsOptions {
	/** Hard cap for one run. */
	limit?: number;
	/** Batches in flight at once. */
	concurrency?: number;
	/** Re-extract rows whose text hash is unchanged. */
	force?: boolean;
	/** Store nothing; return what the model answered. */
	dryRun?: boolean;
	/** Restrict to one property kind (apartment, house, plot). */
	propertyKind?: "apartment" | "house" | "plot" | null;
	onProgress?: (progress: {
		done: number;
		total: number;
		stored: number;
		empty: number;
		errors: number;
	}) => void;
}

export interface ExtractFactsSummary {
	model: string;
	promptVersion: string;
	scanned: number;
	sent: number;
	/** Rows persisted with at least one fact. */
	stored: number;
	/**
	 * Rows persisted with no fact at all (the model answered nothing, or the
	 * row was missing from the answer). They carry the text hash, so the offer
	 * counts as processed and is never sent again for that text.
	 */
	empty: number;
	promoted: number;
	/**
	 * Listings whose stored facts changed in a way scoring reads (gate
	 * evidence, condition/defects, plot media/access, setting). Their stored
	 * score predates the facts, so the refresh re-scores them before
	 * rebuilding the leaderboard.
	 */
	gateIds: number[];
	skipped: number;
	errors: number;
	firstErrors: string[];
	durationMs: number;
}

/** Longest text a listing needs for the model to have anything to read. */
const MIN_DESCRIPTION_CHARS = 60;
/**
 * A title is prose too. Court-auction notices (licytacje-komornik) and several
 * new-development rows carry no description at all and state the area, rooms,
 * address, land register and share in the title, so a title-only offer is sent
 * when the title itself is long enough to carry those facts. The prompt already
 * renders such a row as "OPIS: (brak opisu)".
 */
const MIN_TITLE_CHARS = 25;

/**
 * Which offers are worth a call: a description with a few sentences, or a long
 * enough title. One predicate for the price scan of a run and for the pending
 * counter, so the /sources number matches what the extractor actually sends.
 */
function hasProse() {
	return or(
		sql`length(coalesce(${listings.description}, '')) >= ${MIN_DESCRIPTION_CHARS}`,
		sql`length(trim(coalesce(${listings.title}, ''))) >= ${MIN_TITLE_CHARS}`,
	);
}

/** Rows inspected per run to find `limit` still-unprocessed listings. */
const SCAN_FACTOR = 6;

function oneLine(error: unknown): string {
	if (error instanceof Error) {
		const cause =
			error.cause instanceof Error ? ` <- ${error.cause.message}` : "";
		return `${error.name}: ${error.message}${cause}`;
	}
	return String(error);
}

/** `plot_area_m2` is meters; the model occasionally answers in ares. */
function plotArea(facts: ListingFacts): number | null {
	const area = facts.plotAreaM2;
	if (area == null) return null;
	return area < 20 ? Math.round(area * 100) : Math.round(area);
}

/** better-sqlite3 binds no booleans: an amenity flag is 0/1 or NULL. */
function flag(value: boolean | null): number | null {
	return value == null ? null : value ? 1 : 0;
}

/**
 * Fill only the columns that are still empty. `coalesce(column, value)` keeps
 * whatever the portal (or an earlier, better source) already said, and a null
 * fact is a no-op. One statement, because a batch answers for many columns.
 */
async function promoteFacts(
	listingId: number,
	facts: ListingFacts,
): Promise<void> {
	const plotType = facts.plotType === "lesna" ? "leśna" : facts.plotType;
	const material =
		facts.buildingMaterial === "cellular_concrete"
			? "pustak"
			: facts.buildingMaterial;
	const floor = facts.floor == null ? null : String(facts.floor);
	// v2 quotes the monthly rent; the existing admin_fee column is where
	// scoring looks for the true cost of a flat.
	const adminFee = facts.monthlyCosts?.rent ?? null;
	await db.run(sql`
		update ${listings} set
			heating_type = coalesce(heating_type, ${facts.heating}),
			building_type = coalesce(building_type, ${facts.buildingType}),
			plot_type = coalesce(plot_type, ${plotType}),
			building_material = coalesce(building_material, ${material}),
			condition = coalesce(condition, ${facts.condition}),
			ownership = coalesce(ownership, ${facts.ownership}),
			market = coalesce(market, ${facts.market}),
			build_year = coalesce(build_year, ${facts.buildYear}),
			plot_area_m2 = coalesce(plot_area_m2, ${plotArea(facts)}),
			floor = coalesce(floor, ${floor}),
			floor_count = coalesce(floor_count, ${facts.floorCount}),
			admin_fee = coalesce(admin_fee, ${adminFee}),
			has_balcony = coalesce(has_balcony, ${flag(facts.hasBalcony)}),
			has_terrace = coalesce(has_terrace, ${flag(facts.hasTerrace)}),
			has_garden = coalesce(has_garden, ${flag(facts.hasGarden)}),
			has_elevator = coalesce(has_elevator, ${flag(facts.hasElevator)}),
			has_parking = coalesce(has_parking, ${flag(facts.hasParking)}),
			has_garage = coalesce(has_garage, ${flag(facts.hasGarage)}),
			has_basement = coalesce(has_basement, ${flag(facts.hasBasement)})
		where ${listings.id} = ${listingId}
	`);
}

/**
 * Extract facts for listings that still need them. The default limit keeps a
 * refresh run bounded; the script passes a larger one.
 */
export async function extractListingFacts(
	options: ExtractFactsOptions = {},
): Promise<ExtractFactsSummary> {
	const startedAt = Date.now();
	const limit = options.limit ?? 200;
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const model = llmModel();
	const summary: ExtractFactsSummary = {
		model,
		promptVersion: FACT_PROMPT_VERSION,
		scanned: 0,
		sent: 0,
		stored: 0,
		empty: 0,
		promoted: 0,
		gateIds: [],
		skipped: 0,
		errors: 0,
		firstErrors: [],
		durationMs: 0,
	};
	const recordError = (error: unknown) => {
		summary.errors += 1;
		if (summary.firstErrors.length < 5)
			summary.firstErrors.push(oneLine(error));
	};

	const kindFilter = options.propertyKind
		? eq(listings.propertyKind, options.propertyKind)
		: undefined;
	const rows = await db
		.select({
			id: listings.id,
			title: listings.title,
			description: listings.description,
		})
		.from(listings)
		.where(
			and(
				eq(listings.offerType, "sale"),
				eq(listings.isActive, true),
				eq(listings.isVisible, true),
				hasProse(),
				kindFilter,
			),
		)
		.orderBy(desc(listings.firstSeenAt), desc(listings.id))
		.limit(Math.max(limit * SCAN_FACTOR, limit + 50));

	summary.scanned = rows.length;
	if (rows.length === 0) {
		summary.durationMs = Date.now() - startedAt;
		return summary;
	}

	const existing = new Map<number, FactKnownRow>();
	if (!options.force) {
		const ids = rows.map((row) => row.id);
		for (let start = 0; start < ids.length; start += 500) {
			const chunk = ids.slice(start, start + 500);
			const known = await db
				.select({
					listingId: listingFacts.listingId,
					sourceHash: listingFacts.sourceHash,
					promptVersion: listingFacts.promptVersion,
				})
				.from(listingFacts)
				.where(inArray(listingFacts.listingId, chunk));
			for (const fact of known) {
				existing.set(fact.listingId, {
					hash: fact.sourceHash,
					version: fact.promptVersion,
				});
			}
		}
	}

	// The only place a send queue is built: deduped ids, hash match skipped.
	const selection = selectFactCandidates(rows, {
		limit,
		known: existing,
		force: options.force,
	});
	summary.skipped = selection.skipped;
	const queue = selection.queue;

	const batches = factBatches(queue);

	const runBatch = async (batch: (typeof queue)[number][]): Promise<void> => {
		summary.sent += batch.length;
		const ids = batch.map((row) => row.id);
		const [system, user] = factPrompt(batch);
		const text = await chatText({
			model,
			systemPrompt: system?.content ?? "",
			messages: [{ role: "user", content: user?.content ?? "" }],
			threadId: `facts-${batch[0]?.id ?? 0}-${batch.length}`,
		});
		// A null answer is a failed batch: nothing is stored, so the same rows
		// are retried on the next run. Only a cleanly parsed batch reaches
		// `factRowOutcomes`, and only then may an omitted row be stored as an
		// empty answer; a failed batch never writes anything.
		const answer = parseFactsAnswer(text, ids);
		if (!answer) {
			throw new Error(
				"model answer was not a JSON results array; nothing stored for this batch",
			);
		}
		const outcomes = factRowOutcomes(answer, ids);
		for (const row of batch) {
			const facts = outcomes.get(row.id) ?? null;
			// An empty answer is stored as `{}` with the text hash, so a text
			// the model already read is never sent again.
			await storeListingFacts(row.id, {
				facts,
				sourceHash: row.hash,
				model,
				promptVersion: FACT_PROMPT_VERSION,
				dryRun: options.dryRun,
			});
			if (!facts) {
				summary.empty += 1;
				continue;
			}
			summary.stored += 1;
			if (options.dryRun) continue;
			summary.promoted += 1;
			// Every stored fact feeds scoring (gates, condition/defects, plot
			// buildability, the setting bonus, the quality correction), and the
			// score predates it. Empty answers never reach this point.
			summary.gateIds.push(row.id);
		}
	};

	let done = 0;
	for (let start = 0; start < batches.length; start += concurrency) {
		const slice = batches.slice(start, start + concurrency);
		const results = await Promise.allSettled(
			slice.map((batch) => runBatch(batch)),
		);
		for (const result of results) {
			if (result.status === "rejected") recordError(result.reason);
		}
		done += slice.length;
		options.onProgress?.({
			done: Math.min(done * FACT_BATCH_SIZE, queue.length),
			total: queue.length,
			stored: summary.stored,
			empty: summary.empty,
			errors: summary.errors,
		});
	}

	summary.durationMs = Date.now() - startedAt;
	return summary;
}

/** How many sale offers still lack facts, for the /sources page. */
export async function countListingsMissingFacts(): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(listings)
		.leftJoin(listingFacts, eq(listingFacts.listingId, listings.id))
		.where(
			and(
				eq(listings.offerType, "sale"),
				eq(listings.isActive, true),
				eq(listings.isVisible, true),
				hasProse(),
				// A row stored under an older prompt version is pending again: its
				// hash no longer describes what the current prompt reads.
				or(
					sql`${listingFacts.listingId} is null`,
					ne(listingFacts.promptVersion, FACT_PROMPT_VERSION),
				),
			),
		);
	return Number(row?.count ?? 0);
}

// --- Inline extraction (before the row is stored) ------------------------

/**
 * A crawl-produced offer, before it is stored. The inline extractor reads the
 * exact title and description the sink is about to write, so the fact set and
 * the stored row describe the same text. The crawl order is therefore
 * scrape -> facts -> store -> score, and the alert cut only ever sees offers
 * whose facts are already in the database.
 */
export interface FactSourceListing {
	source: string;
	externalId: string;
	title: string;
	description: string | null;
	/** Defaults to "sale"; rentals are stored without facts. */
	offerType?: string | null;
}

/** Facts for one offer, ready to be written together with the listing row. */
export interface PreparedListingFacts {
	facts: ListingFacts | null;
	sourceHash: string;
	model: string;
	promptVersion: string;
}

export interface InlineFactsSummary {
	/** Offers the crawl handed over. */
	offered: number;
	/** Distinct sale offers with enough prose to be worth a call. */
	eligible: number;
	sent: number;
	/** Already extracted from this exact text. */
	skipped: number;
	/** Answers that carried at least one fact. */
	stored: number;
	/** Answers that carried none; they are stored as processed, not pending. */
	empty: number;
	errors: number;
	firstErrors: string[];
	/** `source:externalId` -> facts, for the sink to write with the row. */
	prepared: Map<string, PreparedListingFacts>;
	durationMs: number;
}

function factKey(source: string, externalId: string): string {
	return `${source}:${externalId}`;
}

/**
 * Write one offer's facts and promote the columns scoring reads. The sink
 * calls this immediately after the listing upsert (so the FK exists), which is
 * why it takes a listing id; the batch extractor calls it per row as well.
 * Promotion only fills empty columns, so a portal-published fact always wins.
 */
export async function storeListingFacts(
	listingId: number,
	prepared: PreparedListingFacts & { dryRun?: boolean },
): Promise<void> {
	if (prepared.dryRun) return;
	const factsJson = prepared.facts ? JSON.stringify(prepared.facts) : "{}";
	await db
		.insert(listingFacts)
		.values({
			listingId,
			model: prepared.model,
			promptVersion: prepared.promptVersion,
			sourceHash: prepared.sourceHash,
			factsJson,
		})
		.onConflictDoUpdate({
			target: listingFacts.listingId,
			set: {
				model: prepared.model,
				promptVersion: prepared.promptVersion,
				sourceHash: prepared.sourceHash,
				factsJson,
				extractedAt: new Date(),
			},
		});
	if (prepared.facts) await promoteFacts(listingId, prepared.facts);
}

/** Is this ad worth a call: a description with a few sentences, or a long title. */
function inlineProseEligible(
	title: string,
	description: string | null,
): boolean {
	return (
		promptDescription(description).length >= MIN_DESCRIPTION_CHARS ||
		title.trim().length >= MIN_TITLE_CHARS
	);
}

/** Hashes of the offers already read under the current prompt, by `source:id`. */
async function loadKnownFactHashes(
	rows: readonly FactSourceListing[],
): Promise<Map<string, { hash: string; version: string }>> {
	const bySource = new Map<string, string[]>();
	for (const row of rows) {
		const ids = bySource.get(row.source) ?? [];
		ids.push(row.externalId);
		bySource.set(row.source, ids);
	}
	const out = new Map<string, { hash: string; version: string }>();
	for (const [source, ids] of bySource) {
		for (let start = 0; start < ids.length; start += 400) {
			const chunk = ids.slice(start, start + 400);
			const known = await db
				.select({
					source: listings.source,
					externalId: listings.externalId,
					hash: listingFacts.sourceHash,
					version: listingFacts.promptVersion,
				})
				.from(listings)
				.innerJoin(listingFacts, eq(listingFacts.listingId, listings.id))
				.where(
					and(eq(listings.source, source), inArray(listings.externalId, chunk)),
				);
			for (const row of known) {
				out.set(factKey(row.source, row.externalId), {
					hash: row.hash,
					version: row.version,
				});
			}
		}
	}
	return out;
}

/**
 * Read the facts of the offers a crawl just produced, before they are stored.
 *
 * This is the same prompt, parser and normalization as the batch drain; only
 * the queue differs. Instead of scanning the database for offers that still
 * need facts, it is handed the crawl's own output, so every offer is enriched
 * in the run that discovered it and scored with its facts already in place.
 * A text already read under the current prompt (an unchanged re-crawl) is
 * skipped by hash, so the model is still called at most once per text.
 *
 * Failure isolation: a batch that fails stores nothing for its offers, they
 * are saved without facts, and the refresh's `listing-facts` repair phase
 * picks them up later. The crawl itself never fails because the model did.
 */
export async function extractFactsForListings(
	list: readonly FactSourceListing[],
	options: {
		concurrency?: number;
		/** Store nothing; used by the API-free checks. */
		dryRun?: boolean;
		onProgress?: (progress: {
			done: number;
			total: number;
			stored: number;
			empty: number;
			errors: number;
		}) => void;
	} = {},
): Promise<InlineFactsSummary> {
	const startedAt = Date.now();
	const concurrency = Math.max(1, options.concurrency ?? 4);
	const model = llmModel();
	const summary: InlineFactsSummary = {
		offered: list.length,
		eligible: 0,
		sent: 0,
		skipped: 0,
		stored: 0,
		empty: 0,
		errors: 0,
		firstErrors: [],
		prepared: new Map(),
		durationMs: 0,
	};
	const recordError = (error: unknown) => {
		summary.errors += 1;
		if (summary.firstErrors.length < 5)
			summary.firstErrors.push(oneLine(error));
	};
	if (!llmConfigured()) {
		summary.durationMs = Date.now() - startedAt;
		return summary;
	}

	// One entry per offer: a crawl may emit the same ad twice (list card plus
	// detail page); the richer text wins, and the key is what the sink knows.
	const deduped = new Map<string, FactSourceListing>();
	for (const row of list) {
		if ((row.offerType ?? "sale") !== "sale") continue;
		if (!inlineProseEligible(row.title, row.description)) continue;
		const key = factKey(row.source, row.externalId);
		const previous = deduped.get(key);
		if (
			!previous ||
			(row.description?.length ?? 0) > (previous.description?.length ?? 0)
		) {
			deduped.set(key, row);
		}
	}
	summary.eligible = deduped.size;
	if (deduped.size === 0) {
		summary.durationMs = Date.now() - startedAt;
		return summary;
	}

	const known = await loadKnownFactHashes([...deduped.values()]);
	// Synthetic ids for the prompt: they only have to be unique inside the run,
	// and the answer is mapped back to the offer by id.
	const queue: Array<{
		id: number;
		key: string;
		input: { id: number; title: string; description: string | null };
		hash: string;
	}> = [];
	for (const [key, row] of deduped) {
		const hash = factTextHash(row.title, row.description);
		const seen = known.get(key);
		if (seen && seen.hash === hash && seen.version === FACT_PROMPT_VERSION) {
			summary.skipped += 1;
			continue;
		}
		const id = queue.length;
		queue.push({
			id,
			key,
			input: { id, title: row.title, description: row.description },
			hash,
		});
	}
	if (queue.length === 0) {
		summary.durationMs = Date.now() - startedAt;
		return summary;
	}

	const byId = new Map(queue.map((entry) => [entry.id, entry] as const));
	const batches = factBatches(queue.map((entry) => entry.input));

	const runBatch = async (batch: FactInput[]): Promise<void> => {
		summary.sent += batch.length;
		const ids = batch.map((row) => row.id);
		const [system, user] = factPrompt(batch);
		const text = await chatText({
			model,
			systemPrompt: system?.content ?? "",
			messages: [{ role: "user", content: user?.content ?? "" }],
			threadId: `facts-inline-${batch[0]?.id ?? 0}-${batch.length}`,
		});
		const answer = parseFactsAnswer(text, ids);
		if (!answer) {
			throw new Error(
				"model answer was not a JSON results array; nothing stored for this batch",
			);
		}
		const outcomes = factRowOutcomes(answer, ids);
		for (const row of batch) {
			const entry = byId.get(row.id);
			if (!entry) continue;
			const facts = outcomes.get(row.id) ?? null;
			summary.prepared.set(entry.key, {
				facts,
				sourceHash: entry.hash,
				model,
				promptVersion: FACT_PROMPT_VERSION,
			});
			if (facts) summary.stored += 1;
			else summary.empty += 1;
		}
	};

	let done = 0;
	for (let start = 0; start < batches.length; start += concurrency) {
		const slice = batches.slice(start, start + concurrency);
		const results = await Promise.allSettled(
			slice.map((batch) => runBatch(batch)),
		);
		for (const result of results) {
			if (result.status === "rejected") recordError(result.reason);
		}
		done += slice.length;
		options.onProgress?.({
			done: Math.min(done * FACT_BATCH_SIZE, queue.length),
			total: queue.length,
			stored: summary.stored,
			empty: summary.empty,
			errors: summary.errors,
		});
	}

	summary.durationMs = Date.now() - startedAt;
	return summary;
}
