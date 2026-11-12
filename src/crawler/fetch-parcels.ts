/**
 * Bulk-fetch specific cadastral parcels into the local `parcels` index.
 *
 * The region-wide importer walks bbox tiles; this command is for a known
 * list of registry ids (a model holdout, a backlog, a backfill). It skips
 * ids already present and uses batched OGC `Or` filters, about 50 ids per
 * request.
 *
 *   bunx tsx src/crawler/fetch-parcels.ts data/model_parcels.txt
 */

import "dotenv/config";

import { readFile } from "node:fs/promises";

import { inArray } from "drizzle-orm";

import { db } from "#/db/index";
import { parcels } from "#/db/schema";
import {
	fetchParcelById,
	fetchParcelByUldk,
	fetchParcelsByIds,
} from "./egib.ts";
import { storeEgibParcel } from "./parcel-index.ts";

const BATCH = 10;
const MIN_SPLIT = 5;
const VALID_ID = /^\d{6}_\d\.\d{4}\./;

async function existingIds(ids: string[]): Promise<Set<string>> {
	const found = new Set<string>();
	for (let i = 0; i < ids.length; i += 400) {
		const rows = await db
			.select({ parcelId: parcels.parcelId })
			.from(parcels)
			.where(inArray(parcels.parcelId, ids.slice(i, i + 400)));
		for (const r of rows) found.add(r.parcelId);
	}
	return found;
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path) {
		console.error("usage: fetch-parcels.ts <ids.txt> [--limit=N]");
		process.exit(2);
	}
	const limitArg = process.argv.find((a) => a.startsWith("--limit="));
	const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : null;
	const useUldk = !process.argv.includes("--no-uldk");
	const uldkArg = process.argv.find((a) => a.startsWith("--uldk-cap="));
	let uldkCap = uldkArg ? Number.parseInt(uldkArg.split("=")[1], 10) : 9_000;
	const text = await readFile(path, "utf8");
	const ids = [
		...new Set(
			text
				.split(/\s+/)
				.map((s) => s.trim())
				.filter((s) => VALID_ID.test(s)),
		),
	];
	const selected = limit != null ? ids.slice(0, limit) : ids;
	console.log(`fetch-parcels: ${selected.length}/${ids.length} ids from ${path}`);

	const present = await existingIds(selected);
	const missing = selected.filter((id) => !present.has(id));
	console.log(`  ${present.size} already present, ${missing.length} to fetch`);

	let fetched = 0;
	let empty = 0;
	let uldkFetched = 0;
	const fetchBatch = async (batch: string[]): Promise<Awaited<ReturnType<typeof fetchParcelsByIds>>> => {
		if (batch.length === 0) return [];
		if (batch.length === 1) {
			// A single <Or> child is rejected by the aggregate WFS; use the
			// direct equality filter instead.
			const one = await fetchParcelById(batch[0]);
			return one ? [one] : [];
		}
		try {
			return await fetchParcelsByIds(batch);
		} catch (err) {
			const message = String(err);
			const network = /fetch failed|timeout|aborted|ECONN/i.test(message);
			if (network) {
				// A flaky gateway, not a bad id. Retry once after a longer
				// pause; splitting would only multiply the failing requests.
				await new Promise((r) => setTimeout(r, 8000));
				try {
					return await fetchParcelsByIds(batch);
				} catch {
					console.warn(`  network failure on ${batch.length} ids, skipped`);
					return [];
				}
			}
			if (message.includes("503") || message.includes("500")) {
				await new Promise((r) => setTimeout(r, 3000));
				try {
					return await fetchParcelsByIds(batch);
				} catch {
					// fall through to split
				}
			}
			if (batch.length <= MIN_SPLIT) {
				console.warn(`  batch of ${batch.length} failed: ${message.slice(0, 120)}`);
				return [];
			}
			const mid = Math.ceil(batch.length / 2);
			const left = await fetchBatch(batch.slice(0, mid));
			const right = await fetchBatch(batch.slice(mid));
			return [...left, ...right];
		}
	};
	for (let i = 0; i < missing.length; i += BATCH) {
		const batch = missing.slice(i, i + BATCH);
		const rows = await fetchBatch(batch);
		if (useUldk && rows.length < batch.length && uldkCap > 0) {
			const got = new Set(rows.map((r) => r.parcelId));
			for (const id of batch) {
				if (got.has(id) || uldkCap <= 0) continue;
				try {
					const one = await fetchParcelByUldk(id);
					if (one) {
						rows.push(one);
						uldkFetched++;
					}
				} catch (err) {
					console.warn(`  uldk ${id} failed: ${String(err).slice(0, 80)}`);
				}
				uldkCap--;
				await new Promise((r) => setTimeout(r, 300));
			}
		}
		for (const row of rows) await storeEgibParcel(row);
		fetched += rows.length;
		empty += batch.length - rows.length;
		const done = i + batch.length;
		const pct = Math.round((done / missing.length) * 100);
		console.log(
			`JCODE_PROGRESS ${JSON.stringify({ percent: pct, current: done, total: missing.length, unit: "parcels", message: `${fetched} stored, ${uldkFetched} via ULDK` })}`,
		);
		await new Promise((r) => setTimeout(r, 500));
	}
	console.log(
		`fetch-parcels done: ${fetched} stored, ${empty} not found, ${uldkFetched} via ULDK (cap left ${uldkCap})`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
