/**
 * Pin the per-kind listing schema: every database column is mapped, the map
 * agrees with the SQL views, and a plot/house/flat projection hides the fields
 * that do not apply while still showing any out-of-schema value that a portal
 * happened to fill in.
 *
 * Run with `bun run validate:listing-schema` (needs the database for the view
 * checks; the pure checks run without it).
 */
import { getTableColumns } from "drizzle-orm";

import { db } from "#/db/index";
import { listings } from "#/db/schema";
import {
	buildListingRecord,
	FIELD_GROUPS,
	LISTING_FIELDS,
	offerTypeOf,
	viewColumns,
} from "#/lib/listing-schema";

let failures = 0;
function check(ok: boolean, label: string, detail?: unknown): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) {
		failures++;
		if (detail !== undefined) console.log("      ", detail);
	}
}

// --- The map covers the table exactly -----------------------------------
const columns = getTableColumns(listings) as Record<string, { name: string }>;
const tableKeys = Object.keys(columns);
const mapped = LISTING_FIELDS.map((field) => field.key);
const duplicates = mapped.filter((key, index) => mapped.indexOf(key) !== index);
check(duplicates.length === 0, "no column is mapped twice", duplicates);
check(
	tableKeys.length === mapped.length &&
		tableKeys.every((key) => mapped.includes(key)),
	"every listings column is in the schema map",
	{
		missing: tableKeys.filter((key) => !mapped.includes(key)),
		unknown: mapped.filter((key) => !tableKeys.includes(key)),
	},
);
const groups = new Set<string>(FIELD_GROUPS);
check(
	LISTING_FIELDS.every((field) => groups.has(field.group)),
	"every field belongs to a declared group",
	LISTING_FIELDS.filter((field) => !groups.has(field.group)).map((f) => f.key),
);

// --- Kinds get their own columns ----------------------------------------
const flat = viewColumns("apartment");
const house = viewColumns("house");
const plot = viewColumns("plot");
check(
	!plot.includes("heatingType") &&
		!plot.includes("buildingType") &&
		!plot.includes("buildYear") &&
		!plot.includes("floor") &&
		!plot.includes("areaM2"),
	"the plot schema has no building or flat fields",
	plot.filter((key) =>
		["heatingType", "buildingType", "buildYear", "floor", "areaM2"].includes(
			key,
		),
	),
);
check(
	flat.includes("heatingType") && !flat.includes("plotType"),
	"the flat schema has heating and no plot type",
	{ heatingType: flat.includes("heatingType"), plotType: flat.includes("plotType") },
);
check(
	house.includes("heatingType") &&
		house.includes("plotType") &&
		house.includes("plotAreaM2"),
	"the house schema carries both the building and the plot",
	house.filter((key) => ["heatingType", "plotType", "plotAreaM2"].includes(key)),
);

// --- The record projection follows the schema ---------------------------
const row = {
	id: 1,
	price: 500_000,
	pricePerM2: 10_000,
	areaM2: 50,
	heatingType: "miejskie",
	buildingType: "blok",
	plotType: null,
	plotAreaM2: null,
	minimumStayNights: null,
	offerType: "sale",
};
// A plot row as the API returns it: the building columns exist but are null.
const plotRow = { ...row, heatingType: null, buildingType: null };
const plotRecord = buildListingRecord(plotRow, "plot", "sale");
const plotKeys = plotRecord.groups.flatMap((group) =>
	group.fields.map((field) => field.key),
);
check(
	!plotKeys.includes("heatingType") &&
		!plotKeys.includes("buildingType") &&
		plotRecord.excluded.includes("heatingType"),
	"a plot record shows no heating/building fields",
	plotRecord.excluded,
);
check(
	!plotKeys.includes("areaM2") && plotKeys.includes("price"),
	"a plot record drops the flat area but keeps the price",
	plotKeys,
);
check(
	plotRecord.groups.some((group) => group.title === "Ogłoszenie") &&
		plotRecord.groups.every(
			(group) => !group.fields.some((field) => field.key === "areaM2"),
		),
	"the plot record is grouped by the declared sections",
	plotRecord.groups.map((group) => group.title),
);

const mixedPlot = buildListingRecord(
	{ ...plotRow, heatingType: "miejskie" },
	"plot",
	"sale",
);
check(
	mixedPlot.extra.some((field) => field.key === "heatingType"),
	"an out-of-schema value on a plot is kept under 'poza schematem'",
	mixedPlot.extra,
);

// The portal's own type and the building type are one field for a flat or a
// house: the record shows a single row, and the portal type is the fallback
// when nobody stated a building type.
const foldedFlat = buildListingRecord(
	{ ...row, propertyType: "apartment", buildingType: null },
	"apartment",
	"sale",
);
const foldedKeys = foldedFlat.groups.flatMap((group) =>
	group.fields.map((field) => field.key),
);
const foldedField = foldedFlat.groups
	.flatMap((group) => group.fields)
	.find((field) => field.key === "buildingType");
check(
	foldedKeys.includes("buildingType") && !foldedKeys.includes("propertyType"),
	"the portal type folds into the building field instead of a second row",
	foldedKeys,
);
check(
	foldedField?.value === "apartment" && foldedField.note === undefined,
	"with no building type the folded field carries the portal type once",
	foldedField,
);

const bothTypes = buildListingRecord(
	{ ...row, propertyType: "apartment", buildingType: "block" },
	"apartment",
	"sale",
);
const bothField = bothTypes.groups
	.flatMap((group) => group.fields)
	.find((field) => field.key === "buildingType");
check(
	bothField?.value === "block" && bothField.note === "typ z portalu: apartment",
	"a stated building type wins and the portal type becomes its note",
	bothField,
);

const portalPlot = buildListingRecord(
	{ ...plotRow, propertyType: "plot" },
	"plot",
	"sale",
);
const portalPlotKeys = portalPlot.groups.flatMap((group) =>
	group.fields.map((field) => field.key),
);
check(
	portalPlotKeys.includes("propertyType") &&
		!portalPlotKeys.includes("buildingType"),
	"a plot keeps the portal type row (it has no building)",
	portalPlotKeys,
);

const strRow = buildListingRecord(
	{ ...row, offerType: "short_term_rental", minimumStayNights: 2, rating: 4.8 },
	"apartment",
	"short_term_rental",
);
const strKeys = strRow.groups.flatMap((group) =>
	group.fields.map((field) => field.key),
);
check(
	strKeys.includes("minimumStayNights") && strKeys.includes("rating"),
	"a short-term rental shows its own fields",
	strKeys.filter((key) => ["minimumStayNights", "rating"].includes(key)),
);
check(
	strRow.excluded.includes("deposit") &&
		strRow.excluded.includes("adminFee") &&
		strRow.excluded.includes("auctionType"),
	"a short-term rental hides long-term and auction fields",
	strRow.excluded.filter((key) =>
		["deposit", "adminFee", "auctionType"].includes(key),
	),
);
const rentRow = buildListingRecord(
	{ ...row, offerType: "long_term_rental", adminFee: 900, deposit: 3_000 },
	"apartment",
	"long_term_rental",
);
const rentKeys = rentRow.groups.flatMap((group) =>
	group.fields.map((field) => field.key),
);
check(
	rentKeys.includes("adminFee") && rentKeys.includes("deposit"),
	"a long-term rental keeps the rent fields",
	rentKeys.filter((key) => ["adminFee", "deposit"].includes(key)),
);
check(
	offerTypeOf(null) === "sale" &&
		offerTypeOf("long_term_rental") === "long_term_rental" &&
		offerTypeOf("short_term_rental") === "short_term_rental",
	"offer types default to sale and keep both rentals distinct",
	[offerTypeOf(null), offerTypeOf("long_term_rental"), offerTypeOf("short_term_rental")],
);

// --- The SQL views exist and match the map ------------------------------
const viewChecks: Array<[string, string]> = [
	["listing_flats", "apartment"],
	["listing_houses", "house"],
	["listing_plots", "plot"],
];
for (const [view, kind] of viewChecks) {
	const rows = (await db.$client.prepare(`pragma table_info("${view}")`).all()) as Array<{
		name: string;
	}>;
	if (rows.length === 0) {
		check(false, `view ${view} exists (run bun run build:listing-views --write)`, view);
		continue;
	}
	const expected = viewColumns(kind as never).map((key) => columns[key]?.name);
	const actual = rows.map((row) => row.name);
	check(
		expected.length === actual.length &&
			actual.every((name) => expected.includes(name)),
		`view ${view} matches the ${kind} schema`,
		{
			missing: expected.filter((name) => !actual.includes(name)),
			unexpected: actual.filter((name) => !expected.includes(name)),
		},
	);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
