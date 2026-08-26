/**
 * Full Airbnb quadtree drain through the production pipeline
 * (crawlSite -> Effect validation -> saveListings upsert into SQLite).
 *
 * Coverage grows run over run via the persistent tile frontier in
 * data/crawler/airbnb-quadtree.json; saturated tiles split automatically.
 *
 * Usage: AIRBNB_MAX_REQUESTS=4000 npx tsx scripts/drain-airbnb.ts [budget]
 */
import { crawlSite } from "../src/crawler/crawler.ts";
import { airbnbAdapter } from "../src/crawler/sites/airbnb.ts";

const budget = Number(process.argv[2] ?? 4000);
process.env.AIRBNB_MAX_REQUESTS = String(budget);

console.log(`drain-airbnb: budget=${budget} requests per run`);
const t0 = Date.now();
const { listings, pages } = await crawlSite(airbnbAdapter);
const uniques = new Set(listings.map((l) => l.externalId));
const withCoords = listings.filter((l) => l.lat !== null).length;
console.log(
	`done: pages=${pages} rows=${listings.length} uniques=${uniques.size} ` +
		`withCoords=${withCoords} elapsed=${((Date.now() - t0) / 60000).toFixed(1)}min`,
);
