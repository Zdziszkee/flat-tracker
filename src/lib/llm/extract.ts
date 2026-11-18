/**
 * Batch runner for model-extracted listing facts.
 *
 * Reads sale offers that carry prose, sends them to the model in small
 * batches, stores the answer in `listing_facts` and promotes the facts into
 * the listing columns scoring reads. Only empty columns are filled:
 * a portal-published fact always wins over an interpreted one.
 *
 * Re-runs are cheap and idempotent. Each stored row keeps a hash of the text
 * it came from, so an unchanged listing is never sent again; a changed price
 * or description is (the hash covers both). The prompt version participates
 * too, so a better prompt re-visits the whole corpus.
 *
 * Failure isolation matches the rest of the pipeline: one bad batch is
 * counted and reported, the run continues, and the caller gets the first few
 * error messages with their causes intact.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listingFacts, listings } from "#/db/schema";
import { chatText, llmModel } from "./client.ts";
import {
	FACT_BATCH_SIZE,
	FACT_PROMPT_VERSION,
	type FactInput,
	factPrompt,
	isEmptyFacts,
	type ListingFacts,
	parseFactsResponse,
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
		errors: number;
	}) => void;
}

export interface ExtractFactsSummary {
	model: string;
	promptVersion: string;
	scanned: number;
	sent: number;
	stored: number;
	promoted: number;
	/**
	 * Listings whose gate-relevant columns (heating, building style, plot type)
	 * were filled by this run. Their stored score predates the facts, so the
	 * refresh re-scores them before rebuilding the leaderboard.
	 */
	gateIds: number[];
	skipped: number;
	errors: number;
	firstErrors: string[];
	durationMs: number;
}

/** Longest text a listing needs for the model to have anything to read. */
const MIN_DESCRIPTION_CHARS = 60;
/** Rows inspected per run to find `limit` still-unprocessed listings. */
const SCAN_FACTOR = 6;

function textHash(title: string, description: string | null): string {
	return createHash("sha256")
		.update(`${FACT_PROMPT_VERSION}\u0000${title}\u0000${description ?? ""}`)
		.digest("hex");
}

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
	await db.run(sql`
		update ${listings} set
			heating_type = coalesce(heating_type, ${facts.heating}),
			building_type = coalesce(building_type, ${facts.buildingType}),
			plot_type = coalesce(plot_type, ${plotType}),
			building_material = coalesce(building_material, ${material}),
			condition = coalesce(condition, ${facts.condition}),
			ownership = coalesce(ownership, ${facts.ownership}),
			build_year = coalesce(build_year, ${facts.buildYear}),
			plot_area_m2 = coalesce(plot_area_m2, ${plotArea(facts)}),
			floor = coalesce(floor, ${floor}),
			floor_count = coalesce(floor_count, ${facts.floorCount}),
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
				sql`length(coalesce(${listings.description}, '')) >= ${MIN_DESCRIPTION_CHARS}`,
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

	const existing = new Map<string, { hash: string; version: string }>();
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
				existing.set(String(fact.listingId), {
					hash: fact.sourceHash,
					version: fact.promptVersion,
				});
			}
		}
	}

	const queue: Array<FactInput & { hash: string }> = [];
	for (const row of rows) {
		if (queue.length >= limit) break;
		const hash = textHash(row.title, row.description);
		const known = existing.get(String(row.id));
		if (known && known.hash === hash && known.version === FACT_PROMPT_VERSION) {
			summary.skipped += 1;
			continue;
		}
		queue.push({
			id: row.id,
			title: row.title,
			description: row.description,
			hash,
		});
	}

	const batches: Array<Array<FactInput & { hash: string }>> = [];
	for (let start = 0; start < queue.length; start += FACT_BATCH_SIZE) {
		batches.push(queue.slice(start, start + FACT_BATCH_SIZE));
	}

	const runBatch = async (
		batch: Array<FactInput & { hash: string }>,
	): Promise<void> => {
		summary.sent += batch.length;
		const [system, user] = factPrompt(batch);
		const text = await chatText({
			model,
			systemPrompt: system?.content ?? "",
			messages: [{ role: "user", content: user?.content ?? "" }],
			threadId: `facts-${batch[0]?.id ?? 0}-${batch.length}`,
		});
		const parsed = parseFactsResponse(
			text,
			batch.map((row) => row.id),
		);
		for (const row of batch) {
			const facts = parsed.get(row.id);
			if (!facts || isEmptyFacts(facts)) continue;
			if (options.dryRun) {
				summary.stored += 1;
				continue;
			}
			await db
				.insert(listingFacts)
				.values({
					listingId: row.id,
					model,
					promptVersion: FACT_PROMPT_VERSION,
					sourceHash: row.hash,
					factsJson: JSON.stringify(facts),
				})
				.onConflictDoUpdate({
					target: listingFacts.listingId,
					set: {
						model,
						promptVersion: FACT_PROMPT_VERSION,
						sourceHash: row.hash,
						factsJson: JSON.stringify(facts),
						extractedAt: new Date(),
					},
				});
			summary.stored += 1;
			await promoteFacts(row.id, facts);
			summary.promoted += 1;
			if (facts.heating || facts.buildingType || facts.plotType) {
				summary.gateIds.push(row.id);
			}
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
				sql`length(coalesce(${listings.description}, '')) >= ${MIN_DESCRIPTION_CHARS}`,
				sql`${listingFacts.listingId} is null`,
			),
		);
	return Number(row?.count ?? 0);
}
