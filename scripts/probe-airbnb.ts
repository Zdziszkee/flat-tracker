/**
 * Probe an Airbnb search URL: page-1 result count, cursor count, and the
 * coordinate spread of results. Throwaway diagnostic.
 */
const url = process.argv[2];
if (!url) {
	console.error("usage: tsx probe-airbnb.ts <url>");
	process.exit(1);
}

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
const m = html.match(
	/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/,
);
if (!m) {
	console.log("no deferred state script; html length", html.length);
	process.exit(0);
}
const data = JSON.parse(m[1]);

const results = findKey(data, "searchResults");
const paginationInfo = findKey(data, "paginationInfo") as any;
const cursors: string[] = Array.isArray(paginationInfo?.pageCursors)
	? paginationInfo.pageCursors
	: [];
console.log("page1 results:", Array.isArray(results) ? results.length : 0);
console.log("cursor count:", cursors.length);

// Follow every cursor with plain fetches (like the adapter does), collect
// unique ids + coordinate bbox.
const seenIds = new Set<string>();
let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
let cursor = cursors[0];
let hops = 0;
while (cursor && hops < cursors.length + 2) {
	hops++;
	const u = new URL(url);
	u.searchParams.set("cursor", cursor);
	const r2 = await fetch(u, {
		headers: {
			"user-agent":
				"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
			accept: "text/html,application/xhtml+xml",
			"accept-language": "pl-PL,pl;q=0.9",
		},
	});
	const h2 = await r2.text();
	const m2 = h2.match(
		/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/,
	);
	if (!m2) {
		console.log(`cursor hop ${hops}: no deferred state (status ${r2.status})`);
		break;
	}
	const d2 = JSON.parse(m2[1]);
	const rs = (findKey(d2, "searchResults") as any[]) ?? [];
	for (const r of rs) {
		const id = r?.demandStayListing?.id ?? null;
		if (id && !seenIds.has(id)) {
			seenIds.add(id);
			const lat = r?.demandStayListing?.location?.coordinate?.latitude;
			const lng = r?.demandStayListing?.location?.coordinate?.longitude;
			if (typeof lat === "number" && typeof lng === "number") {
				minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
				minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
			}
		}
	}
	const pi = findKey(d2, "paginationInfo") as any;
	const cs: string[] = Array.isArray(pi?.pageCursors) ? pi.pageCursors : [];
	const cur = u.searchParams.get("cursor") ?? "";
	const idx = cs.indexOf(cur);
	const next = idx >= 0 ? cs[idx + 1] : null;
	console.log(
		`hop ${hops}: got ${rs.length}, uniques ${seenIds.size}, next ${next ? "yes" : "no"}`,
	);
	cursor = next ?? "";
	if (!next) break;
	await new Promise((r3) => setTimeout(r3, 1200));
}
console.log("total uniques:", seenIds.size);
if (seenIds.size > 0)
	console.log(
		"coord bbox:",
		[minLat, minLng, maxLat, maxLng].map((n) => n.toFixed(3)).join(" "),
	);
console.log("(małopolska bbox is 49.18 19.08 -> 50.52 21.42)");

function findKey(node: unknown, key: string): unknown {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const v of node) {
			const r = findKey(v, key);
			if (r) return r;
		}
		return null;
	}
	if (key in (node as Record<string, unknown>))
		return (node as Record<string, unknown>)[key];
	for (const v of Object.values(node)) {
		const r = findKey(v, key);
		if (r) return r;
	}
	return null;
}

export {};
