import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { desc, eq } from "drizzle-orm";
import { visibleListingIds } from "#/lib/listing-visibility";
import { propertyKindOf } from "#/lib/property-kind";
import { isRunning } from "../crawler/progress.ts";
import { refreshLockedByOther } from "../crawler/refresh-lock.ts";
import { db, sqlite } from "./index";
import { buildings, listings } from "./schema";

export interface DerivedReport {
	/** Rows examined by the pass. */
	rows: number;
	/** Rows left visible after cross-source dedupe. */
	visible: number;
	/** Rows whose derived values changed. */
	changed: number;
	elapsedMs: number;
}

/**
 * Recompute the denormalized map/filter fields for every listing.
 *
 * Runs once after a crawl, not per request. The visibility rule itself lives
 * in `src/lib/listing-visibility.ts` so the old route pipeline and the
 * validator read the same definition. New crawl rows keep `derivedAt = null`
 * and are picked up by `ensureListingDerived` on the next read if a refresh
 * did not run its final phase.
 */
export function recomputeListingDerived(): DerivedReport {
	const started = Date.now();
	const rows = db
		.select({
			id: listings.id,
			source: listings.source,
			externalId: listings.externalId,
			title: listings.title,
			address: listings.address,
			features: listings.features,
			price: listings.price,
			areaM2: listings.areaM2,
			rooms: listings.rooms,
			district: listings.district,
			propertyType: listings.propertyType,
			lat: listings.lat,
			lng: listings.lng,
			buildingLat: buildings.lat,
			buildingLng: buildings.lng,
			propertyKind: listings.propertyKind,
			isVisible: listings.isVisible,
			mapLat: listings.mapLat,
			mapLng: listings.mapLng,
		})
		.from(listings)
		.leftJoin(buildings, eq(listings.buildingId, buildings.id))
		// Id is the tie-breaker: morizon/gratka dedupe keeps the first row it
		// sees, so equal scrape timestamps must still produce the same winner
		// on every pass.
		.orderBy(desc(listings.scrapedAt), desc(listings.id))
		.all();

	if (rows.length === 0) {
		return { rows: 0, visible: 0, changed: 0, elapsedMs: Date.now() - started };
	}

	const visible = visibleListingIds(rows);
	const derivedAt = Math.floor(Date.now() / 1000);
	const update = sqlite.prepare(
		`update listings
		 set property_kind = ?, is_visible = ?, map_lat = ?, map_lng = ?, derived_at = ?
		 where id = ?`,
	);
	let changed = 0;
	const apply = sqlite.transaction((entries: typeof rows) => {
		for (const row of entries) {
			const propertyKind = propertyKindOf({
				source: row.source,
				title: row.title,
				propertyType: row.propertyType,
				externalId: row.externalId,
			});
			const isVisible = visible.has(row.id) ? 1 : 0;
			const mapLat = row.buildingLat ?? row.lat;
			const mapLng = row.buildingLng ?? row.lng;
			if (
				row.propertyKind === propertyKind &&
				(row.isVisible ? 1 : 0) === isVisible &&
				row.mapLat === mapLat &&
				row.mapLng === mapLng
			) {
				// Values did not move, but refresh the marker so a row is
				// never re-examined just because it is unchanged.
				update.run(propertyKind, isVisible, mapLat, mapLng, derivedAt, row.id);
				continue;
			}
			update.run(propertyKind, isVisible, mapLat, mapLng, derivedAt, row.id);
			changed++;
		}
	});

	apply(rows);
	return {
		rows: rows.length,
		visible: visible.size,
		changed,
		elapsedMs: Date.now() - started,
	};
}

/**
 * Lazy guard for deployments that already hold listings when this schema
 * lands: the first read after a migration (or after a crawl inserted rows but
 * the refresh's final phase failed) schedules one background rebuild.
 */
let derivedChildRunning = false;

/**
 * Rebuild the stale columns in a child process. The pass takes ~1.3 s on the
 * 47k-row table, and better-sqlite3 is synchronous: running it in the HTTP
 * process blocked `/api/sources` and the facet request for that whole time on
 * the first visit after an interrupted crawl. A child keeps the server
 * responsive; the map serves the current (slightly stale) flags until it
 * finishes, then the next request sees the rebuilt rows.
 */
function spawnDerivedChild(): boolean {
	if (derivedChildRunning) return true;
	const script = resolve(process.cwd(), "scripts/rebuild-listing-derived.ts");
	if (!existsSync(script)) return false;
	try {
		createRequire(import.meta.url).resolve("tsx");
	} catch {
		// A deployment that ships only `.output/` has no tsx runner; leave the
		// refresh's final phase to rebuild the columns instead of blocking.
		return false;
	}
	const child = spawn(process.execPath, ["--import", "tsx", script], {
		cwd: process.cwd(),
		stdio: "ignore",
		detached: true,
	});
	derivedChildRunning = true;
	child.once("exit", () => {
		derivedChildRunning = false;
	});
	child.once("error", () => {
		derivedChildRunning = false;
	});
	child.unref();
	console.log(
		"[listing-derived] stale rows found; rebuilding in the background",
	);
	return true;
}

export function ensureListingDerived(): Promise<DerivedReport | null> {
	const pending = sqlite
		.prepare("select 1 from listings where derived_at is null limit 1")
		.get();
	if (!pending) return Promise.resolve(null);
	// A crawl marks every upserted row stale and runs its own final pass.
	// Recomputing here mid-crawl would race the crawl and stall requests for
	// no benefit; after a crash the lock clears and the next read repairs it.
	if (isRunning() || refreshLockedByOther()) return Promise.resolve(null);
	// Never pay the synchronous pass in the request path.
	spawnDerivedChild();
	return Promise.resolve(null);
}
