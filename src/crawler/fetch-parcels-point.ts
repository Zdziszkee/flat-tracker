/**
 * Recover geometry for stale RCN parcel ids.
 *
 * Many RCN transactions reference parcels that were merged, split or retired
 * since the notarial act. The old id is not in the current cadastre, but the
 * transaction coordinate still identifies the successor parcel. This command
 * reads `parcel_id,lat,lng` rows, queries ULDK GetParcelByXY, and stores the
 * current geometry under the original id as a proxy.
 *
 *   bunx tsx src/crawler/fetch-parcels-point.ts data/missing_parcels.csv --limit=9000
 */

import "dotenv/config";

import { readFile } from "node:fs/promises";

import { inArray } from "drizzle-orm";

import { db } from "#/db/index";
import { parcels } from "#/db/schema";
import { fetchParcelAtPointUldk } from "./egib.ts";
import { storeEgibParcel } from "./parcel-index.ts";

interface PointRow {
	parcelId: string;
	lat: number;
	lng: number;
}

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

async function readPoints(path: string): Promise<PointRow[]> {
	const text = await readFile(path, "utf8");
	const lines = text.split(/\r?\n/).filter((l) => l.trim());
	const out: PointRow[] = [];
	const start = lines[0]?.toLowerCase().includes("parcel") ? 1 : 0;
	for (let i = start; i < lines.length; i++) {
		const [parcelId, latRaw, lngRaw] = lines[i].split(",");
		const lat = Number(latRaw);
		const lng = Number(lngRaw);
		if (!parcelId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		out.push({ parcelId: parcelId.trim(), lat, lng });
	}
	return out;
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path) {
		console.error(
			"usage: fetch-parcels-point.ts <parcel_id,lat,lng.csv> [--limit=N] [--uldk-cap=N]",
		);
		process.exit(2);
	}
	const limitArg = process.argv.find((a) => a.startsWith("--limit="));
	const limit = limitArg ? Number.parseInt(limitArg.split("=")[1], 10) : null;
	const capArg = process.argv.find((a) => a.startsWith("--uldk-cap="));
	let cap = capArg ? Number.parseInt(capArg.split("=")[1], 10) : 9_000;

	const rows = await readPoints(path);
	const unique = new Map<string, PointRow>();
	for (const row of rows) {
		if (!unique.has(row.parcelId)) unique.set(row.parcelId, row);
	}
	const all = [...unique.values()];
	const selected = limit != null ? all.slice(0, limit) : all;
	const present = await existingIds(selected.map((r) => r.parcelId));
	const missing = selected.filter((r) => !present.has(r.parcelId));
	console.log(
		`fetch-parcels-point: ${selected.length}/${all.length} ids, ` +
			`${present.size} present, ${missing.length} to recover`,
	);

	let stored = 0;
	let empty = 0;
	let done = 0;
	let next = 0;
	// Two workers keep ULDK under its 200/minute budget while hiding most of
	// the request latency. The database writes are synchronous, so workers
	// only interleave on the network wait.
	const worker = async (): Promise<void> => {
		for (;;) {
			if (cap <= 0) return;
			const index = next++;
			if (index >= missing.length) return;
			const row = missing[index];
			try {
				const current = await fetchParcelAtPointUldk(row.lat, row.lng);
				if (current) {
					// Store under the original RCN id. The geometry is the current
					// successor parcel at the transaction coordinate, which is what
					// the feature block needs.
					await storeEgibParcel(
						{ ...current, parcelId: row.parcelId },
						"uldk_point",
					);
					stored++;
				} else {
					empty++;
				}
			} catch (err) {
				console.warn(`  ${row.parcelId} failed: ${String(err).slice(0, 100)}`);
				empty++;
			}
			cap--;
			done++;
			if (done % 50 === 0) {
				const pct = Math.round((done / missing.length) * 100);
				console.log(
					`JCODE_PROGRESS ${JSON.stringify({
						percent: pct,
						current: done,
						total: missing.length,
						unit: "parcels",
						message: `${stored} stored, ${empty} empty`,
					})}`,
				);
			}
			await new Promise((r) => setTimeout(r, 400));
		}
	};
	await Promise.all([worker(), worker()]);
	console.log(
		`fetch-parcels-point done: ${stored} stored, ${empty} not found, cap left ${cap}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
