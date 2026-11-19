import "dotenv/config";
import { readFileSync } from "node:fs";
import { extractFactsForListings } from "#/lib/llm/extract";

const [title, ...rest] = readFileSync(
	`${process.env.JCODE_SCRATCH_DIR}/auction.txt`,
	"utf8",
).split("\n");
const summary = await extractFactsForListings([
	{
		source: "_probe",
		externalId: "kobierzynska-60-30",
		title: title ?? "",
		description: rest.join("\n"),
	},
]);
const facts = summary.prepared.get("_probe:kobierzynska-60-30")?.facts;
console.log(
	JSON.stringify(
		{
			sent: summary.sent,
			errors: summary.errors,
			buildingType: facts?.buildingType ?? null,
			largePanel: facts?.largePanel ?? null,
			floor: facts?.floor ?? null,
			floorCount: facts?.floorCount ?? null,
			hasElevator: facts?.hasElevator ?? null,
			hasBalcony: facts?.hasBalcony ?? null,
			hasBasement: facts?.hasBasement ?? null,
			hasParking: facts?.hasParking ?? null,
			condition: facts?.condition ?? null,
			heating: facts?.heating ?? null,
			ownership: facts?.ownership ?? null,
		},
		null,
		1,
	),
);
process.exit(0);
