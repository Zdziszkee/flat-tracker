/**
 * Clear building types that are really the offer kind.
 *
 * gethome's `property.type` is the offer kind ("apartment", "house", "lot"),
 * and the adapter used to promote it into `building_type` as well. That made
 * the record panel show the same word under "typ z portalu" and "rodzaj
 * budynku", and made every gethome flat read as an apartamentowiec in the
 * table, the map popup and the alert card.
 *
 * The adapter no longer writes the column, but an upsert coalesces the old
 * value, so the copies already in the database need one pass. Only a value that
 * is both a kind word and identical to the raw `features.building_type` is
 * cleared: a real building type the model read from the description survives.
 * `apartment` is on the list here (gethome used it for a flat) even though the
 * normalizer keeps it: otodom uses the same word for an apartamentowiec, and
 * this pass is scoped to gethome rows whose raw feature is identical.
 *
 * Idempotent. Run with `bun run fix:building-types`.
 */
import { db } from "#/db/index";

const KIND_WORDS = [
	"lot",
	"land",
	"plot",
	"terrain",
	"grunt",
	"grunty",
	"działka",
	"dzialka",
	"apartment",
	"mieszkanie",
	"flat",
	"lokal",
	"house",
	"dom",
];

const result = await db.$client
	.prepare(
		`update listings
		 set building_type = null
		 where source = 'gethome'
		   and lower(building_type) in (${KIND_WORDS.map(() => "?").join(", ")})
		   and lower(coalesce(
		         json_extract(case when json_valid(features) then features end, '$.building_type'),
		         ''
		       )) = lower(building_type)`,
	)
	.run(...KIND_WORDS);

console.log(
	`Cleared ${result.changes} gethome building type(s) that only repeated the offer kind.`,
);
