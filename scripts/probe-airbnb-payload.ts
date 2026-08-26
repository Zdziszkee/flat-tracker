/**
 * Compare deferred-state payload shapes between two Airbnb search URLs:
 * prints the JSON paths of searchResults / paginationInfo occurrences.
 */
function findPaths(node: unknown, key: string, path = "$"): string[] {
	if (!node || typeof node !== "object") return [];
	if (Array.isArray(node)) {
		const out: string[] = [];
		for (let i = 0; i < Math.min(node.length, 50); i++)
			out.push(...findPaths(node[i], key, `${path}[${i}]`));
		return out;
	}
	const o = node as Record<string, unknown>;
	let out: string[] = [];
	if (key in o) out.push(path);
	for (const [k, v] of Object.entries(o)) out.push(...findPaths(v, key, `${path}.${k}`));
	return out;
}

const url = process.argv[2]!;
const res = await fetch(url, {
	headers: {
		"user-agent":
			"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
		accept: "text/html,application/xhtml+xml",
		"accept-language": "pl-PL,pl;q=0.9",
	},
});
console.log("status", res.status);
const html = await res.text();
console.log("html bytes", html.length);
for (const id of ["data-deferred-state-0", "data-deferred-state-1", "data-deferred-state-2"]) {
	const m = html.match(
		new RegExp(`<script id="${id}"[^>]*>([\\s\\S]*?)</script>`),
	);
	console.log(`--- ${id}: ${m ? `${m[1].length} chars` : "absent"}`);
	if (!m) continue;
	let raw = m[1];
	try {
		const data = JSON.parse(raw);
		for (const key of ["searchResults", "paginationInfo", "pageCursors", "mapSearchResults"]) {
			const paths = findPaths(data, key).slice(0, 4);
			console.log(`  ${key}: ${paths.length ? paths.join(" | ") : "-"}`);
			if (key === "paginationInfo" && paths.length) {
				const get = (p: string): any =>
					p.split(/[.[\]]/).filter(Boolean).slice(1).reduce((acc, part) => acc?.[part.replace("]", "")], data);
				const pi = get(paths[0]);
				console.log(`    pageCursors len: ${pi?.pageCursors?.length ?? "?"}, est: ${JSON.stringify(pi)?.slice(0, 200)}`);
			}
		}
	} catch (e) {
		console.log("  parse fail:", (e as Error).message.slice(0, 100));
	}
}

export {};
