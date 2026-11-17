/**
 * Guard for the /sources registry.
 *
 * The failure this prevents: a new import or phase starts recording runs (or
 * emitting progress) under an id that has no descriptor, so it crawls without
 * ever appearing on the page — exactly how gugik-import, building-assign and
 * the parcel phases were invisible.
 *
 * It reads the registry and the refresh pipeline as TEXT (no imports, no DB),
 * so it is fast and cannot pull the crawler graph: `bun run validate:sources`.
 */
import { readFileSync } from "node:fs";

const REGISTRY = "src/crawler/source-status.ts";
const REFRESH = "src/crawler/refresh.ts";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
	if (ok) {
		console.log(`PASS  ${name}`);
		return;
	}
	failures++;
	console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
}

interface Descriptor {
	id: string;
	group: string;
	kind: string;
	staticLayer: boolean;
}

const registrySource = readFileSync(REGISTRY, "utf8");

/** Every descriptor object in the literal, in source order. */
function parseDescriptors(text: string): Descriptor[] {
	const descriptors: Descriptor[] = [];
	// Split on the `id` key rather than on indentation: the literal's
	// formatting may change without the validator silently skipping entries.
	for (const block of text.split(/\n\s*id:\s*"/u).slice(1)) {
		const id = block.match(/^([^"]+)"/)?.[1];
		if (!id) continue;
		const group = block.match(/group:\s*"([^"]+)"/)?.[1] ?? "";
		const kind = block.match(/kind:\s*"([^"]+)"/)?.[1] ?? "";
		descriptors.push({
			id,
			group,
			kind,
			staticLayer: /static:\s*true/u.test(block),
		});
	}
	return descriptors;
}

const descriptors = parseDescriptors(registrySource);
console.log(`registry: ${descriptors.length} descriptors`);

check("registry is not empty", descriptors.length > 0);
check(
	"descriptor ids are unique",
	new Set(descriptors.map((d) => d.id)).size === descriptors.length,
	`${new Set(descriptors.map((d) => d.id)).size} unique of ${descriptors.length}`,
);

const GROUPS = new Set(["portal", "data", "processing"]);
const KINDS = new Set([
	"portal",
	"rcn",
	"geocode",
	"airbnb-calendar",
	"public-investments",
	"price-index",
	"layer",
	"enrich",
	"scoring",
]);

for (const descriptor of descriptors) {
	check(
		`${descriptor.id}: group is valid`,
		GROUPS.has(descriptor.group),
		descriptor.group,
	);
	check(
		`${descriptor.id}: kind is valid`,
		KINDS.has(descriptor.kind),
		descriptor.kind,
	);
	if (descriptor.staticLayer) {
		check(`${descriptor.id}: static layers are layers`, descriptor.kind === "layer");
	}
}

// A static dataset is bundled at build time: it can never record a run.
const byId = new Map(descriptors.map((d) => [d.id, d]));

const refreshSource = readFileSync(REFRESH, "utf8");
const recorded = new Set<string>();
for (const match of refreshSource.matchAll(/recordCrawlRun\(\{\s*source:\s*"([^"]+)"/gu)) {
	if (match[1]) recorded.add(match[1]);
}
const progressed = new Set<string>();
for (const match of refreshSource.matchAll(/setSourceProgress\(\s*"([^"]+)"/gu)) {
	if (match[1]) progressed.add(match[1]);
}

console.log(
	`refresh.ts: ${recorded.size} recorded sources, ${progressed.size} progress ids`,
);

for (const id of new Set([...recorded, ...progressed])) {
	check(`refresh id "${id}" has a descriptor`, byId.has(id));
}

for (const id of recorded) {
	check(`recorded source "${id}" is not a static layer`, byId.get(id)?.staticLayer !== true);
}

check(
	"every data layer is recorded, static or file-fresh",
	descriptors
		.filter((d) => d.group === "data")
		.every(
			(d) =>
				d.staticLayer ||
				recorded.has(d.id) ||
				/freshnessFile:\s*"/u.test(registrySource.split(`id: "${d.id}"`)[1] ?? ""),
		),
);

if (failures > 0) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nALL PASS");
