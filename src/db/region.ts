import { type SQL, sql } from "drizzle-orm";

/**
 * The regions this app actually tracks.
 *
 * Listings come from małopolskie + śląskie portals, the map is bounded to
 * Kraków, the powiat choropleth is małopolskie-only — but the RCN import
 * covers the whole country (`import-rcn-gugik.ts --all`). Every query that
 * used to read "transactions" therefore has to say out loud which
 * transactions it means: without this, a national drain silently turns a
 * Kraków price chart into a national average and drags ~20M out-of-region
 * rows through the powiat point-in-polygon.
 *
 * The scope is a pair of coordinate boxes (every row of either voivodeship
 * with geometry falls inside its box, and no other region does). A single
 * box spanning both would be wrong, not merely coarse: it would swallow
 * most of świętokrzyskie and draw Kielce into the charts.
 *
 * Those boxes are materialized as the generated column `transactions.region`
 * (see `REGION_CASE_SQL` and its use in `schema.ts`), and every regional
 * query says `region is not null` (or `region = 'malopolskie'`). That
 * indirection is not decoration — it is the only predicate form SQLite will
 * actually drive a partial index with. Measured on 24.3M transactions
 * (małopolskie 1.8M + śląskie 2.8M rows, dev.db copy):
 *
 *   - two-rectangle OR as the index AND query predicate:
 *     `explain query plan` -> SCAN transactions, 5.6 s; forcing it with
 *     `INDEXED BY` fails with "no query solution". SQLite does not match a
 *     partial index whose WHERE clause is OR-connected, so a verbatim
 *     copy of the predicate is still useless.
 *   - a single bounding box over both regions: index matched, but the box
 *     holds ~250k rows of świętokrzyskie/opolskie, i.e. Kielce in the
 *     charts (and ~3.5M entries instead of 2.8M).
 *   - `region is not null` against the partial index below: SEARCH USING
 *     INDEX, index-only, 336 ms. `region = 'malopolskie'` against its own
 *     index: 147 ms.
 *
 * The generated expression is baked into the table, so changing a box is a
 * schema change, not just a constant edit: SQLite cannot alter a generated
 * column in place, so it needs a table rebuild. `scripts/validate-regions.ts`
 * compares the stored expression with `REGION_CASE_SQL` and fails loudly
 * instead of letting a silent mismatch mis-bucket every new row.
 */

export interface RegionBox {
	readonly minLat: number;
	readonly maxLat: number;
	readonly minLng: number;
	readonly maxLng: number;
}

/**
 * Tracked voivodeships, keyed as in TERYT / Geofabrik region slugs. Boxes
 * may overlap (these two do, along the Kraków-Częstochowa border); the
 * overlap is resolved by declaration order in `regionOf`, so a row in the
 * strip counts as małopolskie and is never counted twice.
 */
export const TRACKED_REGIONS = {
	malopolskie: {
		minLat: 49.15,
		maxLat: 50.55,
		minLng: 19.05,
		maxLng: 21.45,
	},
	slaskie: {
		minLat: 49.35,
		maxLat: 51.02,
		minLng: 18.3,
		maxLng: 20.05,
	},
} as const satisfies Record<string, RegionBox>;

export type TrackedRegion = keyof typeof TRACKED_REGIONS;

/** Tracked regions in declaration order (which is the overlap priority). */
export const TRACKED_REGION_IDS = Object.keys(
	TRACKED_REGIONS,
) as TrackedRegion[];

/** Małopolska box alone — kept under its historical name. */
export const MALOPOLSKA_BBOX: RegionBox = TRACKED_REGIONS.malopolskie;
/** Śląskie box alone. */
export const SLASKIE_BBOX: RegionBox = TRACKED_REGIONS.slaskie;

/** `lat between ... and lng between ...` for one box (no parentheses needed). */
function boxPredicate(box: RegionBox): string {
	return (
		`lat between ${box.minLat} and ${box.maxLat} and ` +
		`lng between ${box.minLng} and ${box.maxLng}`
	);
}

/** Małopolska-only coordinate predicate text. */
export const MALOPOLSKA_BBOX_SQL = boxPredicate(MALOPOLSKA_BBOX);
/** Śląskie-only coordinate predicate text. */
export const SLASKIE_BBOX_SQL = boxPredicate(SLASKIE_BBOX);

/**
 * Body of the generated `transactions.region` column: the coordinate boxes
 * as a CASE. The result is NULL for a row outside every tracked region
 * (including one with no geometry), which is exactly what the `is not null`
 * predicates below mean.
 */
export const REGION_CASE_SQL = `case ${TRACKED_REGION_IDS.map(
	(id) => `when ${boxPredicate(TRACKED_REGIONS[id])} then '${id}'`,
).join(" ")} end`;

/**
 * Predicate text shared verbatim by the partial index in `schema.ts` and by
 * every region-wide query: "this row belongs to a tracked region".
 */
export const REGION_PREDICATE_SQL = "region is not null";
/** `and <region>` for a raw `sql` template's WHERE clause. */
export const inTrackedRegions: SQL = sql.raw(REGION_PREDICATE_SQL);

/**
 * Małopolska-only predicate text, also shared verbatim with its index. Used
 * by the powiat choropleth, whose boundary dataset covers małopolskie
 * alone; it selects the same rows as the historical coordinate box (the
 * CASE's first branch IS that box), just in a form SQLite can index.
 */
export const MALOPOLSKA_REGION_PREDICATE_SQL = "region = 'malopolskie'";
/** `and <region>` for a raw `sql` template's WHERE clause (małopolskie only). */
export const inMalopolska: SQL = sql.raw(MALOPOLSKA_REGION_PREDICATE_SQL);

function insideBox(box: RegionBox, lat: number, lng: number): boolean {
	return (
		lat >= box.minLat &&
		lat <= box.maxLat &&
		lng >= box.minLng &&
		lng <= box.maxLng
	);
}

/**
 * In-process twin of the `region` column (same declaration order, so the
 * same answer for a point in the overlap). Use it where a coordinate never
 * reaches SQL: geocoder validation, importers, tests.
 */
export function regionOf(lat: number, lng: number): TrackedRegion | null {
	for (const id of TRACKED_REGION_IDS) {
		if (insideBox(TRACKED_REGIONS[id], lat, lng)) return id;
	}
	return null;
}

/** Is this point inside any tracked region? */
export function isInTrackedRegion(lat: number, lng: number): boolean {
	return regionOf(lat, lng) !== null;
}
