import "dotenv/config";

import { eq, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { listings } from "#/db/schema";
import { parseUtilities } from "./utilities.ts";

/**
 * Backfill rental utility fees: first parse whatever the description
 * mentions, then estimate the rest from similar listings (building, then
 * district). Estimated values are marked `estimated: true`.
 */
async function main(): Promise<void> {
	const candidates = await db
		.select({ id: listings.id, description: listings.description })
		.from(listings)
		.where(
			sql`${listings.offerType} = 'long_term_rental' and ${listings.utilities} is null`,
		)
		.all();

	let parsed = 0;
	for (const row of candidates) {
		const utilities = parseUtilities(row.description);
		if (!utilities) continue;
		await db.update(listings).set({ utilities }).where(eq(listings.id, row.id));
		parsed++;
	}

	const missing = await db
		.select({
			id: listings.id,
			buildingId: listings.buildingId,
			district: listings.district,
		})
		.from(listings)
		.where(
			sql`${listings.offerType} = 'long_term_rental' and ${listings.utilities} is null`,
		)
		.all();

	let filled = 0;
	for (const row of missing) {
		const source = await db
			.select({ utilities: listings.utilities })
			.from(listings)
			.where(
				row.buildingId != null
					? sql`${listings.offerType} = 'long_term_rental' and ${listings.utilities} is not null and ${listings.buildingId} = ${row.buildingId}`
					: sql`${listings.offerType} = 'long_term_rental' and ${listings.utilities} is not null and ${listings.district} = ${row.district ?? ""}`,
			)
			.limit(1)
			.get();

		if (!source?.utilities) continue;
		try {
			const parsed = JSON.parse(source.utilities) as Record<string, unknown>;
			parsed.estimated = true;
			await db
				.update(listings)
				.set({ utilities: JSON.stringify(parsed) })
				.where(eq(listings.id, row.id));
			filled++;
		} catch {
			// Skip malformed source JSON.
		}
	}

	console.log(
		`estimate-utilities: parsed=${parsed} estimated=${filled} missing=${missing.length}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
