/**
 * Catalogue of the GUGiK RCN bulk exports ("Usługa Transakcje").
 *
 * The download directory has no index — a GET on it answers 404 — so the
 * catalogue is the URL space itself: every powiat (TERYT4) that answers
 * 200 on
 *
 *   https://opendata.geoportal.gov.pl/InneDane/latest_exports/
 *     rcn_transakcje_ceny/GPKG/{teryt}_transakcje_ceny.gpkg.zip
 *
 * exists. `discoverPowiats()` HEAD-probes that space once and caches the
 * result (with byte sizes, which give the import a progress denominator).
 * The whole country is 380 packages; małopolska is the 22 that the app
 * shows on the map.
 *
 *   bunx tsx scripts/discover-rcn-powiats.ts   # refresh the cache
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RCN_GPKG_BASE_URL =
	"https://opendata.geoportal.gov.pl/InneDane/latest_exports/rcn_transakcje_ceny/GPKG";

export const TERYT_INDEX_PATH = "data/rcn/gugik/teryt-index.json";

/** Voivodeship prefixes (TERYT pairs 02..32). */
const VOIVODESHIPS = [
	"02",
	"04",
	"06",
	"08",
	"10",
	"12",
	"14",
	"16",
	"18",
	"20",
	"22",
	"24",
	"26",
	"28",
	"30",
	"32",
] as const;

/**
 * Powiat-within-voivodeship codes: 01..45 (ziemskie) + 61..80 (cities with
 * powiat rights). The city run is long — śląskie has 19 of them, so it
 * ends at 2479 — and probing past the end costs one 404.
 */
const POWIAT_CODES = [
	...Array.from({ length: 45 }, (_, i) => String(i + 1).padStart(2, "0")),
	...Array.from({ length: 20 }, (_, i) => String(i + 61).padStart(2, "0")),
];

export interface PowiatPackage {
	/** TERYT4 code, e.g. "1201" (krakowski) or "1465" (Warszawa). */
	teryt: string;
	/** Size of the zipped GeoPackage in bytes. */
	bytes: number;
}

export type PowiatIndex = Record<string, { bytes: number }>;

export function powiatZipUrl(teryt: string): string {
	return `${RCN_GPKG_BASE_URL}/${teryt}_transakcje_ceny.gpkg.zip`;
}

export function readPowiatIndex(): PowiatIndex | null {
	try {
		const raw = JSON.parse(
			readFileSync(TERYT_INDEX_PATH, "utf8"),
		) as PowiatIndex;
		return Object.keys(raw).length > 0 ? raw : null;
	} catch {
		return null;
	}
}

interface ProbeOptions {
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
}

/** HEAD-probe every candidate TERYT4 and return the ones that exist. */
export async function discoverPowiats(
	opts: ProbeOptions = {},
): Promise<PowiatPackage[]> {
	const concurrency = opts.concurrency ?? 8;
	const candidates: string[] = [];
	for (const v of VOIVODESHIPS) {
		for (const p of POWIAT_CODES) candidates.push(`${v}${p}`);
	}
	const queue = [...candidates];
	const hits: PowiatPackage[] = [];
	const unresolved: string[] = [];
	let done = 0;

	const probe = async (
		teryt: string,
	): Promise<{ kind: "ok" | "absent" | "unknown"; bytes?: number }> => {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const res = await fetch(powiatZipUrl(teryt), {
					method: "HEAD",
					signal: AbortSignal.timeout(45_000),
				});
				if (res.ok) {
					return {
						kind: "ok",
						bytes: Number(res.headers.get("content-length") ?? 0),
					};
				}
				if (res.status === 404) return { kind: "absent" };
			} catch {
				/* throttle / transient: retry with backoff */
			}
			await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
		}
		return { kind: "unknown" };
	};

	const worker = async (): Promise<void> => {
		for (;;) {
			const teryt = queue.shift();
			if (!teryt) return;
			const res = await probe(teryt);
			if (res.kind === "ok") hits.push({ teryt, bytes: res.bytes ?? 0 });
			else if (res.kind === "unknown") unresolved.push(teryt);
			done++;
			opts.onProgress?.(done, candidates.length);
		}
	};
	await Promise.all(Array.from({ length: concurrency }, () => worker()));

	// Additive cache: a HEAD that timed out (or hit the WAF) must never
	// delete a powiat we already knew about, or a flaky run would silently
	// shrink the country. Known packages get their size refreshed, unknown
	// codes keep whatever the previous run recorded.
	const previous = readPowiatIndex() ?? {};
	const index: PowiatIndex = { ...previous };
	for (const h of hits)
		index[h.teryt] = { bytes: h.bytes || previous[h.teryt]?.bytes || 0 };
	for (const teryt of unresolved) {
		console.warn(`  probe inconclusive for ${teryt}; keeping known state`);
	}
	mkdirSync(path.dirname(TERYT_INDEX_PATH), { recursive: true });
	writeFileSync(TERYT_INDEX_PATH, JSON.stringify(index, null, 1));
	return Object.entries(index)
		.map(([teryt, v]) => ({ teryt, bytes: v.bytes }))
		.sort((a, b) => a.teryt.localeCompare(b.teryt));
}

/**
 * Packages published by GUGiK, cheapest source first: the cached index,
 * otherwise a fresh probe (the importer's national mode has to work on a
 * fresh clone without a manual discovery step).
 */
export async function loadPowiatPackages(): Promise<PowiatPackage[]> {
	const cached = readPowiatIndex();
	if (cached) {
		return Object.entries(cached)
			.map(([teryt, v]) => ({ teryt, bytes: v.bytes }))
			.sort((a, b) => a.teryt.localeCompare(b.teryt));
	}
	return discoverPowiats();
}
