/**
 * Refresh the local catalogue of GUGiK RCN powiat packages.
 *
 * The download directory has no index (a GET on it 404s), so the catalogue
 * is the URL space itself: every TERYT4 that answers 200 on
 * `{teryt}_transakcje_ceny.gpkg.zip` is published. This HEAD-probes the
 * ~800 plausible TERYT4 codes (01..45 ziemskie + 61..66 cities, per
 * voivodeship), records each package's size and caches the result in
 * `data/rcn/gugik/teryt-index.json`.
 *
 *   bunx tsx scripts/discover-rcn-powiats.ts
 *
 * The import script falls back to this same discovery when the cache is
 * missing, so this is just the standalone/pre-warm entry point.
 */

import { discoverPowiats, TERYT_INDEX_PATH } from "../src/crawler/rcn-gugik-index.ts";

discoverPowiats({
	onProgress: (done, total) => {
		if (done % 100 === 0) console.log(`  ... ${done}/${total} probed`);
	},
})
	.then((hits) => {
		const total = hits.reduce((s, h) => s + h.bytes, 0);
		console.log(
			`found ${hits.length} powiat packages, ${(total / 1e9).toFixed(2)} GB total`,
		);
		console.log(`written to ${TERYT_INDEX_PATH}`);
		const biggest = [...hits].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
		for (const b of biggest) {
			console.log(`  ${b.teryt}: ${(b.bytes / 1e6).toFixed(1)} MB`);
		}
	})
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
