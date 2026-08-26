/**
 * Enrich Airbnb listings from their room (detail) pages: guest capacity,
 * bedrooms/beds/bathrooms, amenities, precise-ish coordinates, rating,
 * description. Writes straight to SQLite and is resumable:
 *
 * - rows with `max_guests IS NULL` still need a pass (PDP personCapacity
 *   is always present, so it doubles as the "enriched" marker),
 * - pages that 404 / carry no state are recorded in
 *   data/crawler/airbnb-enrich-skip.json so reruns don't re-hit them.
 *
 * Usage: npx tsx scripts/enrich-airbnb.ts [budget]   (default 3000)
 */
import "dotenv/config";
import fs from "node:fs";

const budget = Number(process.argv[2] ?? 3000);

const { db } = await import("../src/db/index.ts");
const { listings } = await import("../src/db/schema.ts");
const { parseRoomHtml } = await import("../src/crawler/sites/airbnb-detail.ts");
const { eq, sql } = await import("drizzle-orm");

const SKIP_FILE = "data/crawler/airbnb-enrich-skip.json";
const skip: Set<string> = fs.existsSync(SKIP_FILE)
	? new Set(JSON.parse(fs.readFileSync(SKIP_FILE, "utf8")) as string[])
	: new Set();

const HEADERS = {
	"user-agent":
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
	"accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
	accept: "text/html,application/xhtml+xml",
};

interface Row {
	id: number;
	externalId: string;
	url: string;
	features: string | null;
}

const rows = (await db
	.select({
		id: listings.id,
		externalId: listings.externalId,
		url: listings.url,
		features: listings.features,
	})
	.from(listings)
	.where(
		sql`${listings.source} = 'airbnb' AND ${listings.maxGuests} IS NULL AND ${listings.isActive} = 1`,
	)) as Row[];

const todo = rows.filter((r) => !skip.has(r.externalId));
console.log(
	`enrich-airbnb: budget=${budget}, ${todo.length} to enrich ` +
		`(${rows.length - todo.length} previously skipped, ${skip.size} total skips)`,
);

let done = 0;
let enriched = 0;
let skipped404 = 0;
let throttled = 0;

async function fetchRoom(url: string): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	try {
		const res = await fetch(url, {
			headers: HEADERS,
			redirect: "follow",
			signal: controller.signal,
		});
		if (res.status === 404 || res.status === 410) return null;
		if (res.status === 403 || res.status === 429) {
			throttled++;
			await new Promise((r) => setTimeout(r, 60_000));
			return null;
		}
		if (!res.ok) return null;
		return await res.text();
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function mergeFeatures(oldJson: string | null, details: ReturnType<typeof parseRoomHtml>): string | null {
	let base: Record<string, unknown> = {};
	if (oldJson) {
		try {
			base = JSON.parse(oldJson) as Record<string, unknown>;
		} catch {
			base = {};
		}
	}
	base.amenities = details?.amenities ?? [];
	base.overviewTitle = details?.overviewTitle ?? null;
	base.locationSubtitle = details?.locationSubtitle ?? null;
	base.isExactLocation = details?.isExactLocation ?? null;
	base.spaceType = details?.spaceType ?? null;
	return JSON.stringify(base);
}

const t0 = Date.now();
for (const row of todo) {
	if (done >= budget) break;
	const html = await fetchRoom(row.url);
	done++;
	if (html == null) {
		skipped404++;
		skip.add(row.externalId);
		continue;
	}
	const details = parseRoomHtml(html);
	if (!details || (details.maxGuests == null && details.bedrooms == null)) {
		// No usable state (bot wall, layout change): record so we stop
		// burning budget on this one, but don't treat as fatal.
		skip.add(row.externalId);
		continue;
	}

	await db
		.update(listings)
		.set({
			maxGuests: sql`coalesce(${details.maxGuests}, ${listings.maxGuests})`,
			bedrooms: sql`coalesce(${details.bedrooms}, ${listings.bedrooms})`,
			beds: sql`coalesce(${details.beds}, ${listings.beds})`,
			bathrooms: sql`coalesce(${details.bathrooms}, ${listings.bathrooms})`,
			rating: sql`coalesce(${details.rating}, ${listings.rating})`,
			reviewsCount: sql`coalesce(${details.reviewsCount}, ${listings.reviewsCount})`,
			propertyType: sql`coalesce(${details.propertyType}, ${listings.propertyType})`,
			description: sql`coalesce(${listings.description}, ${details.descriptionShort ?? details.descriptionLong})`,
			lat: sql`coalesce(${listings.lat}, ${details.lat})`,
			lng: sql`coalesce(${listings.lng}, ${details.lng})`,
			features: mergeFeatures(row.features, details),
		})
		.where(eq(listings.id, row.id));
	enriched++;

	if (done % 50 === 0) {
		fs.writeFileSync(SKIP_FILE, JSON.stringify([...skip]));
		const pct = ((done / Math.min(todo.length, budget)) * 100).toFixed(1);
		console.log(
			`JCODE_PROGRESS {"percent":${pct},"current":${done},"total":${Math.min(todo.length, budget)},"message":"enriched=${enriched} skipped=${skipped404}"}`,
		);
	}
	// Polite pacing: ~250ms base between detail fetches.
	await new Promise((r) => setTimeout(r, 250));
}

fs.writeFileSync(SKIP_FILE, JSON.stringify([...skip]));

const cov = await db
	.select({
		withGuests: sql<number>`count(*) filter (where ${listings.maxGuests} is not null)`,
		withBeds: sql<number>`count(*) filter (where ${listings.beds} is not null)`,
		withAmenities: sql<number>`count(*) filter (where ${listings.features} like '%amenities%')`,
		total: sql<number>`count(*)`,
	})
	.from(listings)
	.where(eq(listings.source, "airbnb"));

console.log(
	`done: fetched=${done} enriched=${enriched} dead/skip+${skipped404} elapsed=${((Date.now() - t0) / 60000).toFixed(1)}min`,
);
console.log("coverage:", cov[0]);
