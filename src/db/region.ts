import { sql, type SQL } from "drizzle-orm";

/**
 * The region this app actually tracks.
 *
 * Listings come from małopolska portals, the map is bounded to Kraków, the
 * powiat choropleth is małopolska-only — but the RCN import covers the
 * whole country (`import-rcn-gugik.ts --all`). Every query that used to
 * read "transactions" therefore has to say out loud which transactions it
 * means: without this, a national drain silently turns a Kraków price
 * chart into a national average and drags ~20M out-of-region rows through
 * the powiat point-in-polygon.
 *
 * The scope is expressed as a coordinate box (every małopolska row with
 * geometry falls inside it, and no other region does). `MALOPOLSKA_BBOX_SQL`
 * is deliberately a plain string: SQLite matches a partial index against a
 * query only when the two predicates are structurally identical, so the
 * text below is reused verbatim by the index in `schema.ts` and by the
 * routes. Verify with `explain query plan` after touching either side.
 */
export const MALOPOLSKA_BBOX = {
	minLat: 49.15,
	maxLat: 50.55,
	minLng: 19.05,
	maxLng: 21.45,
} as const;

/** Unqualified predicate text shared by the partial index and its queries. */
export const MALOPOLSKA_BBOX_SQL =
	"lat between 49.15 and 50.55 and lng between 19.05 and 21.45";

/** `and <bbox>` for a raw `sql` template's WHERE clause. */
export const inMalopolska: SQL = sql.raw(MALOPOLSKA_BBOX_SQL);
