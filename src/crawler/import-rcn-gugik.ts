/**
 * Region-wide RCN transaction import from GUGiK's per-powiat bulk exports
 * ("Usługa Transakcje", opendata.geoportal.gov.pl). Kraków (1261) is
 * intentionally skipped: the richer local RCN GML zip (import-rcn.ts)
 * already covers it with notarial-grade data. Every other małopolska
 * powiat comes from here — including parcels that the old flow never
 * had price history for (e.g. Charsznica in powiat miechowski).
 *
 * Two scopes; `rcn-gugik-index.ts` owns the government catalogue and the
 * download URL pattern (mirrors the QGIS "Pobierz dane GUGiK" plugin):
 *
 *   - "malopolska" (default): the 21 małopolska powiaty the map covers.
 *     This is what the hourly server refresh runs, cadence-gated.
 *   - "poland": every package GUGiK publishes (~380 powiaty, several GB
 *     of downloads). A whole-country load is a deliberate, resumable
 *     drain:
 *       bunx tsx src/crawler/import-rcn-gugik.ts --all
 *     `RCN_GUGIK_SCOPE=pl` opts the server refresh into it instead.
 *   Kraków (1261) is skipped in both scopes on purpose: importing it here
 *   would double-count Kraków in the map/building price history that the
 *   local GML already feeds.
 *
 * Each zip unpacks to a GeoPackage with three tables sharing one schema
 * family (transakcje_dzialki / _budynki / _lokale): full transaction
 * facts (prices, VAT, dates) plus a GeoPackage geometry blob whose mean
 * coordinate anchors the row on the map. `dzi_id_dzialki` matches our
 * parcels.parcelId format exactly (the EGIB import feeds the same id
 * space), so parcel binding is an exact join — no fuzzy matching.
 *
 * Daily-cadence: the state file records when each powiat was imported;
 * runs within the cadence window skip the download entirely. Rows are
 * upserted on the unique transactionId (`{teryt}-G/{lokalny_id_iip}`),
 * so re-imports are harmless diffs and a drain that dies halfway resumes
 * at the first powiat it never recorded.
 *
 * Run daily via the refresh pipeline, or manually:
 *   bunx tsx src/crawler/import-rcn-gugik.ts [--force] [--all] [--only=1201,1202]
 */

import "dotenv/config";

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import { parcelMeta, transactions } from "#/db/schema";
import {
	loadPowiatPackages,
	type PowiatPackage,
	powiatZipUrl,
} from "./rcn-gugik-index.ts";

/** Małopolska powiaty (TERYT4); 1261 = Kraków lives in import-rcn.ts. */
const MALOPOLSKA_POWIATY = [
	"1201",
	"1202",
	"1203",
	"1204",
	"1205",
	"1206",
	"1207",
	"1208",
	"1209",
	"1210",
	"1211",
	"1212",
	"1213",
	"1214",
	"1215",
	"1216",
	"1217",
	"1218",
	"1219",
	"1262",
	"1263",
] as const;

const DATA_DIR = "data/rcn/gugik";
const STATE_PATH = `${DATA_DIR}/state.json`;
/** Skip re-download/import if this powiat ran inside the window. */
const CADENCE_HOURS = Number(process.env.RCN_GUGIK_CADENCE_HOURS ?? 20);
/** Powiaty whose history comes from the local RCN GML zip instead. */
const LOCAL_RCN_COVERED = new Set(["1261"]);
/** Rows buffered per powiat before hitting SQLite (keeps memory flat). */
const FLUSH_ROWS = 2000;

export type RcnGugikScope = "malopolska" | "poland";

export interface RcnGugikOptions {
	/** Default: `RCN_GUGIK_SCOPE` env, else "malopolska". */
	scope?: RcnGugikScope;
	/** Ignore the cadence gate and re-import everything in scope. */
	force?: boolean;
	/** Restrict to these TERYT4 codes (retry / spot-import). */
	only?: string[];
	/** Stop after N packages (smoke test against the live source). */
	limit?: number;
}

function resolveScope(env: string | undefined): RcnGugikScope {
	const v = (env ?? "").toLowerCase();
	return v === "pl" || v === "poland" || v === "all" || v === "1"
		? "poland"
		: "malopolska";
}

interface State {
	checkedAt?: Record<string, string>;
}

function readState(): State {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Geometry: GeoPackage binary blob -> mean lat/lng of all vertices.
//
// Layout: "GP"(2) version(1) flags(1) srs_id(int32) [envelope doubles]
// then standard WKB. flags bits1-3 = envelope type (0 none, 1 XY 16B,
// 2 XYZ 24B, 3 XYM 24B, 4 XYZM 32B).

type Pt = { x: number; y: number };

function parseGpkgPoint(buf: Buffer): Pt | null {
	if (buf.length < 8 || buf.toString("ascii", 0, 2) !== "GP") return null;
	const flags = buf[3];
	if (flags & 0x10) return null; // empty geometry
	let sumX = 0;
	let sumY = 0;
	let n = 0;
	// Some exporters ship blobs a byte short of the declared vertex run;
	// pad so the final coordinate read can't go out of bounds (a zeroed
	// low byte shifts a coordinate by <0.001 m — irrelevant for anchors).
	const padded = Buffer.concat([buf, Buffer.alloc(16)]);
	// Some exporters write an envelope wider than the flags imply, so scan
	// the first bytes for the real WKB header: marker 0/1 followed by a
	// sane geometry type word.
	const r = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
	let start = -1;
	for (let o = 8; o < Math.min(64, buf.length - 5); o++) {
		if (buf[o] !== 0 && buf[o] !== 1) continue;
		const littleScan = buf[o] === 1;
		const t = r.getUint32(o + 1, littleScan);
		// Envelope doubles never start with byte 0x00/0x01, so this only
		// matches the real WKB header.
		if (t >= 1 && t <= 7) {
			start = o; // marker position; readWkb consumes marker+type itself
			break;
		}
	}
	if (start < 0) return null;
	const little = buf[start] === 1;
	const rd = (o: number): number => r.getFloat64(o, little);
	const readWkb = (o: number): number => {
		// o = marker byte; the 4-byte type word starts at o+1.
		const geoType = r.getUint32(o + 1, little);
		const base = o + 5;
		switch (geoType & 0xff) {
			case 1: // Point
				sumX += rd(base);
				sumY += rd(base + 8);
				n++;
				return base + 16;
			case 2: // LineString
			case 3: // Polygon
			case 6: {
				// MultiPolygon: average EVERY vertex — robust map anchor.
				// LineString: [count, points...]
				// Polygon:    [ringCount, ([ptCount, points...])...]
				// MultiPolygon: [polyCount, (wkbPolygon)...]
				let p = base;
				const shapes = geoType === 6 ? r.getUint32(p, little) : 1;
				if (geoType === 6) p += 4;
				for (let s = 0; s < shapes; s++) {
					if (geoType === 6) p += 5; // nested WKB header
					if (geoType === 2) {
						const pts = r.getUint32(p, little);
						p += 4;
						for (let k = 0; k < pts; k++) {
							sumX += rd(p);
							sumY += rd(p + 8);
							n++;
							p += 16;
						}
					} else {
						const rings = r.getUint32(p, little);
						p += 4;
						for (let ring = 0; ring < rings; ring++) {
							const pts = r.getUint32(p, little);
							p += 4;
							for (let k = 0; k < pts; k++) {
								sumX += rd(p);
								sumY += rd(p + 8);
								n++;
								p += 16;
							}
						}
					}
				}
				return p;
			}
			case 4: // MultiPoint: [count, (wkbPoint)...]
			case 7: {
				// GeometryCollection: [count, (wkbAny)...] — collect points
				const num = r.getUint32(base - 1, little);
				let p = base + 4;
				for (let i = 0; i < num; i++) {
					p = readWkb(p);
				}
				return p;
			}
			default:
				return buf.length; // unknown -> abort remaining parse
		}
	};
	try {
		readWkb(start);
	} catch {
		return null;
	}
	return n > 0 ? { x: sumX / n, y: sumY / n } : null;
}

// ---------------------------------------------------------------------------
// Geometry srs_id = EPSG:2180 (PUWG 1992): tmerc lon_0=19, x_0=500000,
// y_0=-5300000. One zone for the whole country.
import proj4 from "proj4";

proj4.defs(
	"EPSG:2180",
	"+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
);
const cs92ToWgs = proj4("EPSG:2180", proj4.WGS84);

function pl2000ToLatLng(
	x: number,
	y: number,
): { lat: number; lng: number } | null {
	const [lng, lat] = cs92ToWgs.forward([x, y]);
	// Sanity check against Poland's bounding box — a garbled blob must not
	// land a transaction in the ocean. National scope needs the whole box;
	// the małopolska subset simply never produces points outside it.
	if (lng > 14.0 && lng < 24.3 && lat > 48.9 && lat < 55.1) {
		return { lat, lng };
	}
	return null;
}

// ---------------------------------------------------------------------------
// DB insert

interface RowInsert {
	transactionId: string;
	date: Date | null;
	price: number | null;
	areaM2: number | null;
	pricePerM2: number | null;
	rooms: number | null;
	floor: string | null;
	street: string | null;
	market: number | null;
	lat: number | null;
	lng: number | null;
	parcelId: string | null;
}

function num(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : null;
}

function strDate(v: unknown): Date | null {
	if (typeof v !== "string" || v === "") return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** market encoding matches import-rcn.ts rows already in the DB. */
const MARKET_BY_RYNKU: Record<string, number> = {
	pierwotny: 2,
	wtorny: 1,
};

function insertRows(rows: RowInsert[]): number {
	// date + price are NOT NULL in the schema; transactions missing either
	// carry no usable price history anyway.
	const valid = rows.filter(
		(r): r is RowInsert & { date: Date; price: number } =>
			r.date != null && r.price != null,
	);
	if (valid.length === 0) return 0;
	const res = db
		.insert(transactions)
		.values(valid)
		.onConflictDoNothing({ target: transactions.transactionId })
		.run();
	return res.changes;
}

// ---------------------------------------------------------------------------
// Per-powiat flow

async function downloadPowiat(teryt: string): Promise<string> {
	const url = powiatZipUrl(teryt);
	const zipPath = path.join(DATA_DIR, `${teryt}.gpkg.zip`);
	const res = await fetch(url, {
		signal: AbortSignal.timeout(600_000),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(zipPath, buf);
	const gpkgPath = path.join(DATA_DIR, `${teryt}_transakcje_ceny.gpkg`);
	if (existsSync(gpkgPath)) unlinkSync(gpkgPath);
	execSync(`unzip -o -q "${zipPath}" -d "${DATA_DIR}"`, { stdio: "pipe" });
	return gpkgPath;
}

interface ParcelMetaRow {
	parcelId: string;
	landUse: string | null;
	zoning: string | null;
	areaHa: number | null;
}

/**
 * Stream one GeoPackage into the DB.
 *
 * Deliberately batched instead of "collect everything, then insert": the
 * big city powiaty (Warszawa is a 420 MB zip) hold millions of rows and
 * holding them all as objects would balloon memory for no reason.
 * `onBatch` is called as buffers fill, so peak memory is FLUSH_ROWS.
 */
async function collectFromGpkg(
	gpkgPath: string,
	teryt: string,
	onBatch: (rows: RowInsert[], meta: ParcelMetaRow[]) => Promise<void>,
): Promise<number> {
	const { default: Database } = await import("better-sqlite3");
	const src = new Database(gpkgPath, { readonly: true });
	try {
		let rows: RowInsert[] = [];
		let meta: ParcelMetaRow[] = [];
		let seen = 0;
		const flush = async (): Promise<void> => {
			if (rows.length === 0 && meta.length === 0) return;
			const batchRows = rows;
			const batchMeta = meta;
			rows = [];
			meta = [];
			await onBatch(batchRows, batchMeta);
		};
		const tables: Array<{
			t: string;
			idCol: string;
			area: string[];
			/** true when the area column is hectares (RCN land areas). */
			areaHectares?: boolean;
			price: string[];
			isParcel?: boolean;
			rooms?: string;
			floor?: string;
		}> = [
			{
				t: "transakcje_dzialki",
				idCol: "dzi_id_dzialki",
				area: ["dzi_pow_ewid", "nier_pow_gruntu"],
				areaHectares: true,
				price: ["dzi_cena_brutto", "tran_cena_brutto"],
				isParcel: true,
			},
			{
				t: "transakcje_budynki",
				idCol: "bud_id_budynku",
				area: ["bud_pow_uzyt", "nier_pow_gruntu"],
				price: ["bud_cena_brutto", "tran_cena_brutto"],
				isParcel: false,
			},
			{
				t: "transakcje_lokale",
				idCol: "lok_id_lokalu",
				area: ["lok_pow_uzyt"],
				price: ["lok_cena_brutto", "tran_cena_brutto"],
				isParcel: false,
				rooms: "lok_liczba_izb",
				floor: "lok_nr_kond",
			},
		];

		for (const spec of tables) {
			const hasTable = src
				.prepare("select name from sqlite_master where type='table' and name=?")
				.get(spec.t);
			if (!hasTable) continue;
			const stmt = src.prepare(
				`SELECT tran_lokalny_id_iip AS uid, tran_rodzaj_rynku AS rynk,
				        dok_data AS dok, tran_cena_brutto AS tranCena,
				        ${spec.area.join(", ")}, ${spec.price.join(", ")}${
									spec.rooms ? `, ${spec.rooms}` : ""
								}${spec.floor ? `, ${spec.floor}` : ""}, ${spec.idCol} AS extId,
				         ${
										spec.t === "transakcje_dzialki"
											? "dzi_sposob_uzyt AS su, dzi_przezn_wmpzp AS mpzp, dzi_pow_ewid AS ewidHa"
											: "NULL AS su, NULL AS mpzp, NULL AS ewidHa"
									}, geometry
				 FROM ${spec.t}`,
			);
			const iter = stmt.iterate() as unknown as IterableIterator<
				Record<string, unknown>
			>;
			for (;;) {
				const step = iter.next();
				if (step.done) break;
				const row = step.value;
				const uid = String(row.uid ?? "");
				if (!uid) continue;
				const geom = row.geometry as Buffer | null;
				let lat: number | null = null;
				let lng: number | null = null;
				if (geom) {
					const pt = parseGpkgPoint(geom);
					if (pt) {
						const ll = pl2000ToLatLng(pt.x, pt.y);
						if (ll) {
							lat = ll.lat;
							lng = ll.lng;
						}
					}
				}
				const price = num(row[spec.price[0]]) ?? num(row[spec.price[1]]);
				let area = num(row[spec.area[0]]) ?? num(row[spec.area[1]]);
				if (area != null && spec.areaHectares) area *= 10_000;
				const mktRaw = String(row.rynk ?? "");
				// One transaction (uid) can span MANY parcels — the export
				// carries one row per (transaction x parcel). Include the
				// parcel/unit key in the id or INSERT OR IGNORE would drop
				// every sibling row.
				const extKey = String(row.extId ?? "");
				if (spec.isParcel && extKey) {
					meta.push({
						parcelId: extKey,
						landUse: row.su != null ? String(row.su) : null,
						zoning: row.mpzp != null ? String(row.mpzp) : null,
						areaHa: num(row.ewidHa),
					});
				}
				rows.push({
					transactionId: extKey
						? `${teryt}-G/${uid}/${extKey}`
						: `${teryt}-G/${uid}`,
					date: strDate(row.dok),
					price: price ?? null,
					areaM2: area ?? null,
					pricePerM2:
						price != null && area != null && area >= 5 ? price / area : null,
					rooms: spec.rooms ? num(row[spec.rooms]) : null,
					floor:
						spec.floor && row[spec.floor] != null
							? String(row[spec.floor])
							: null,
					street: null,
					market: MARKET_BY_RYNKU[mktRaw] ?? null,
					lat,
					lng,
					parcelId: spec.isParcel ? extKey || null : null,
				});
				seen++;
				if (rows.length >= FLUSH_ROWS) await flush();
			}
			await flush();
		}
		return seen;
	} finally {
		src.close();
	}
}

/** Parcel land metadata (type/size) — upsert per parcel. */
async function upsertParcelMeta(meta: ParcelMetaRow[]): Promise<void> {
	for (let i = 0; i < meta.length; i += 1000) {
		await db
			.insert(parcelMeta)
			.values(meta.slice(i, i + 1000))
			.onConflictDoUpdate({
				target: parcelMeta.parcelId,
				set: {
					landUse: sql`excluded.land_use`,
					zoning: sql`excluded.zoning`,
					areaHa: sql`excluded.area_ha`,
					updatedAt: new Date(),
				},
			});
	}
}

async function importPowiat(teryt: string): Promise<number> {
	const gpkgPath = await downloadPowiat(teryt);
	let inserted = 0;
	const seen = await collectFromGpkg(gpkgPath, teryt, async (rows, meta) => {
		inserted += insertRows(rows);
		if (meta.length > 0) await upsertParcelMeta(meta);
	});
	// Cleanup heavy intermediates once imported.
	const zipPath = path.join(DATA_DIR, `${teryt}.gpkg.zip`);
	try {
		unlinkSync(zipPath);
		unlinkSync(gpkgPath);
	} catch {
		/* best effort */
	}
	console.log(
		`  RCN-GUGIK ${teryt}: ${seen} transactions seen, ${inserted} new`,
	);
	return inserted;
}

/** Which TERYT4 codes a scope covers, cheapest source first. */
async function targetsForScope(scope: RcnGugikScope): Promise<PowiatPackage[]> {
	if (scope === "malopolska") {
		return MALOPOLSKA_POWIATY.filter((t) => !LOCAL_RCN_COVERED.has(t)).map(
			(teryt) => ({ teryt, bytes: 0 }),
		);
	}
	const packages = await loadPowiatPackages();
	return packages.filter((p) => !LOCAL_RCN_COVERED.has(p.teryt));
}

export async function importRcnGugik(
	opts: RcnGugikOptions = {},
): Promise<number> {
	mkdirSync(DATA_DIR, { recursive: true });
	const scope = opts.scope ?? resolveScope(process.env.RCN_GUGIK_SCOPE);
	const force = opts.force ?? false;
	const state = readState();
	state.checkedAt ??= {};
	const checkedAt = state.checkedAt;

	let targets = await targetsForScope(scope);
	if (opts.only && opts.only.length > 0) {
		const wanted = new Set(opts.only);
		targets = targets.filter((t) => wanted.has(t.teryt));
	}
	const now = Date.now();
	const due = targets.filter(
		(t) =>
			force ||
			now - (checkedAt[t.teryt] ? Date.parse(checkedAt[t.teryt]) : 0) >=
				CADENCE_HOURS * 3600_000,
	);
	const queue = opts.limit ? due.slice(0, opts.limit) : due;

	if (scope === "poland" && LOCAL_RCN_COVERED.size > 0) {
		console.log(
			`RCN-GUGIK scope=poland: ${targets.length} powiat packages published; ` +
				`skipping ${[...LOCAL_RCN_COVERED].join(", ")} (covered by the local RCN GML)`,
		);
	}
	console.log(
		`RCN-GUGIK scope=${scope}: ${queue.length} of ${targets.length} powiaty due ` +
			`(cadence ${CADENCE_HOURS}h, force=${force})`,
	);
	if (queue.length === 0) return 0;

	const totalBytes = queue.reduce((s, t) => s + t.bytes, 0);
	let doneBytes = 0;
	let totalNew = 0;
	let failures = 0;
	const t0 = Date.now();
	for (let i = 0; i < queue.length; i++) {
		const pkg = queue[i];
		const label = `[${i + 1}/${queue.length}] ${pkg.teryt}${
			pkg.bytes ? ` (${(pkg.bytes / 1e6).toFixed(1)} MB)` : ""
		}`;
		console.log(`RCN-GUGIK ${label} ...`);
		try {
			totalNew += await importPowiat(pkg.teryt);
			checkedAt[pkg.teryt] = new Date().toISOString();
			writeFileSync(STATE_PATH, JSON.stringify(state));
		} catch (err) {
			failures++;
			console.error(
				`RCN-GUGIK ${pkg.teryt} failed: ${String(err).slice(0, 200)}`,
			);
		}
		doneBytes += pkg.bytes;
		const elapsed = (Date.now() - t0) / 1000;
		const pct = totalBytes
			? Math.round((doneBytes / totalBytes) * 100)
			: Math.round(((i + 1) / queue.length) * 100);
		const eta = doneBytes
			? Math.round((elapsed / doneBytes) * (totalBytes - doneBytes))
			: 0;
		console.log(
			`JCODE_PROGRESS ${JSON.stringify({
				percent: pct,
				current: i + 1,
				total: queue.length,
				unit: "powiaty",
				message: `RCN-GUGIK ${scope}: ${pkg.teryt} done, ${totalNew} new rows`,
				eta_seconds: eta,
			})}`,
		);
	}
	console.log(
		`RCN-GUGIK scope=${scope} done: ${totalNew} new transactions from ` +
			`${queue.length - failures}/${queue.length} powiaty in ` +
			`${Math.round((Date.now() - t0) / 1000)}s`,
	);
	return totalNew;
}

// CLI: bunx tsx src/crawler/import-rcn-gugik.ts
//        [--force] [--all|--poland] [--only=1201,1202] [--limit=N]
if (process.argv[1]?.replace(/\\/g, "/").endsWith("import-rcn-gugik.ts")) {
	const argv = process.argv.slice(2);
	const onlyArg = argv.find((a) => a.startsWith("--only="));
	const limitArg = argv.find((a) => a.startsWith("--limit="));
	const scope: RcnGugikScope | undefined =
		argv.includes("--all") || argv.includes("--poland")
			? "poland"
			: argv.includes("--malopolska")
				? "malopolska"
				: undefined;
	importRcnGugik({
		scope,
		force: argv.includes("--force"),
		only: onlyArg
			? onlyArg
					.slice("--only=".length)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined,
		limit: limitArg ? Number(limitArg.slice("--limit=".length)) : undefined,
	})
		.then((n) => {
			console.log(`Done: ${n} inserted`);
			process.exit(0);
		})
		.catch((err) => {
			console.error(err);
			process.exit(1);
		});
}

export const __test = { parseGpkgPoint, pl2000ToLatLng };
