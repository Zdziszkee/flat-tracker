/**
 * CLI wrapper around the shared Airbnb enrichment module.
 *
 * Usage: npx tsx scripts/enrich-airbnb.ts [budget]   (default 3000)
 */
import "dotenv/config";

const budget = Number(process.argv[2] ?? 3000);

const { enrichAirbnbDetails } = await import("../src/crawler/airbnb-enrich.ts");
const { db } = await import("../src/db/index.ts");
const { listings } = await import("../src/db/schema.ts");
const { eq, sql } = await import("drizzle-orm");

console.log(`enrich-airbnb: budget=${budget}`);
const t0 = Date.now();
const report = await enrichAirbnbDetails({
	limit: budget,
	onProgress: (p) => {
		const pct = ((p.done / Math.max(p.total, 1)) * 100).toFixed(1);
		console.log(
			`JCODE_PROGRESS {"percent":${pct},"current":${p.done},"total":${p.total},"message":"enriched=${p.enriched} dead=${p.dead} throttled=${p.throttled}"}`,
		);
	},
});

console.log(
	`done: fetched=${report.fetched} enriched=${report.enriched} dead=${report.dead} ` +
		`throttled=${report.throttled} elapsed=${((Date.now() - t0) / 60000).toFixed(1)}min`,
);

const cov = await db
	.select({
		withGuests: sql<number>`count(*) filter (where ${listings.maxGuests} is not null)`,
		withBeds: sql<number>`count(*) filter (where ${listings.beds} is not null)`,
		withAmenities: sql<number>`count(*) filter (where ${listings.features} like '%amenities%')`,
		total: sql<number>`count(*)`,
	})
	.from(listings)
	.where(eq(listings.source, "airbnb"));
console.log("coverage:", cov[0]);
