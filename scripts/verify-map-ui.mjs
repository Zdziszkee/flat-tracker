import { chromium } from "playwright-core";

// Throwaway end-to-end check of the new map/listings UI:
//  1. investmap flat popup shows the Realizacja line
//  2. investmap inv- building popup shows the amber "Inwestycja" label
//  3. budujesie popup still renders (template edits did not break it)
//  4. the days window + sale toggle do NOT hide inv-/budujesie inventory
//  5. /listings shows the Realizacja caption under titles

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const browser = await chromium.launch({
	headless: true,
	executablePath: "/usr/bin/chromium",
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://localhost:3000/map", { waitUntil: "domcontentloaded" });
await page.waitForFunction(
	() => {
		const m = window.__map;
		return (
			m && m.getLayer("listings-circle") && m.isStyleLoaded() && m.getSource("listings")
		);
	},
	null,
	{ timeout: 45000 },
);
await page.waitForFunction(
	() => {
		const s = window.__map.getSource("listings");
		const d = s && (typeof s.getData === "function" ? s.getData() : s._data);
		return d && d.features && d.features.length > 50;
	},
	null,
	{ timeout: 45000 },
);

// Building shells are lazy (created at zoom >= 13): at the default
// camera they must NOT exist yet.
const shellsAbsentAtStart = await page.evaluate(
	() => !window.__map.getLayer("3d-building"),
);
const picks = await page.evaluate(() => {
	const m = window.__map;
	const src = m.getSource("listings");
	const feats = (typeof src.getData === "function" ? src.getData() : src._data)
		.features;
	const counts = new Map();
	for (const f of feats) {
		const k = `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`;
		counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const unique = feats.filter(
		(f) =>
			counts.get(`${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`) ===
			1,
	);
	const find = (pred) => {
		const f = unique.find((x) => pred(x.properties));
		return f
			? {
					coords: f.geometry.coordinates,
					title: f.properties.title,
					externalId: f.properties.externalId,
					label: f.properties.constructionEndLabel,
					budujesie: f.properties.source === "budujesie",
				}
			: null;
	};
	const budFeats = feats;
	const budCounts = new Map();
	for (const f of budFeats) {
		const k = `${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`;
		budCounts.set(k, (budCounts.get(k) ?? 0) + 1);
	}
	const budUnique = budFeats.filter(
		(f) =>
			budCounts.get(`${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`) ===
			1,
	);
	const bud = budUnique.find((f) => f.properties.source === "budujesie");
	return {
		flat: find(
			(p) =>
				p.source === "investmap" &&
				!String(p.externalId).startsWith("inv-") &&
				p.constructionEndLabel,
		),
		inv: find(
			(p) =>
				p.source === "investmap" &&
				String(p.externalId).startsWith("inv-") &&
				p.constructionEndLabel &&
				p.transactionStats != null,
		) ??
			find(
				(p) =>
					p.source === "investmap" &&
					String(p.externalId).startsWith("inv-") &&
					p.constructionEndLabel,
			),
		bud: bud
			? {
					coords: bud.geometry.coordinates,
					title: bud.properties.title,
					externalId: bud.properties.externalId,
					budujesie: true,
				}
			: null,
	};
});

async function clickAndPopup(pick) {
	await page.evaluate(([lng, lat]) => {
		window.__map.jumpTo({ center: [lng, lat], zoom: 18 });
	}, pick.coords);
	await page.waitForTimeout(2500);
	const target = await page.evaluate(([lng, lat]) => {
		const m = window.__map;
		const pt = m.project([lng, lat]);
		const r = document
			.querySelector(".mapboxgl-canvas-container")
			.getBoundingClientRect();
		return { x: pt.x + r.left, y: pt.y + r.top };
	}, pick.coords);
	await page.mouse.click(target.x, target.y);
	await page.waitForTimeout(2000);
	return page.evaluate(() => {
		const el = document.querySelector(".mapboxgl-popup-content");
		return el ? el.innerText : null;
	});
}

// A click can land on a neighbor pin within mapbox's click tolerance; the
// popup must show the picked feature's own title for the check to count.
function popupMatches(text, pick) {
	return Boolean(text && text.includes(pick.title.slice(0, 30)));
}

// 1. flat row popup: Realizacja line
if (picks.flat) {
	const text = await clickAndPopup(picks.flat);
	check(
		"flat popup shows Realizacja line",
		popupMatches(text, picks.flat) &&
			text.includes("Realizacja:") &&
			text.includes(picks.flat.label),
		JSON.stringify((text ?? "").slice(0, 120)),
	);
} else {
	check("flat popup shows Realizacja line", false, "no unique flat pick found");
}

// 2. inv- building popup: amber Inwestycja label + Realizacja line + RCN stats
if (picks.inv) {
	const text = await clickAndPopup(picks.inv);
	check(
		"inv- popup shows Inwestycja label",
		popupMatches(text, picks.inv) &&
			text.includes("Inwestycja") &&
			text.includes("Realizacja:"),
		JSON.stringify((text ?? "").slice(0, 120)),
	);
} else {
	check("inv- popup shows Inwestycja label", false, "no unique inv- pick found");
}

// 2b. RCN history block renders for stats-bearing inv- rows. Their
// building-centroid clusters make any click land on sibling pins, so
// fire the popup for exactly this feature (showListingPopup reads
// e.features[0]) and try a few candidates in case a sibling wrapper
// still steals the event.
const rcnCandidates = await page.evaluate(() => {
	const m = window.__map;
	const src = m.getSource("listings");
	const feats = (typeof src.getData === "function" ? src.getData() : src._data)
		.features;
	return feats
		.map((x, i) => ({ i, x }))
		.filter(
			({ x }) =>
				x.properties.source === "investmap" &&
				String(x.properties.externalId).startsWith("inv-") &&
				x.properties.transactionStats?.txCount > 0,
		)
		.slice(0, 5)
		.map(({ i, x }) => ({ i, title: x.properties.title, coords: x.geometry.coordinates }));
});
let rcnBlockSeen = false;
let rcnLastText = "(no popup)";
let rcnOwnTitleSeen = false;
for (const cand of rcnCandidates) {
	// Jump to the candidate first: the layer wrappers gate on a rendered
	// query at the event point, and replace e.features with its result.
	await page.evaluate(
		({ coords }) => {
			window.__map.jumpTo({ center: coords, zoom: 18 });
		},
		{ coords: cand.coords },
	);
	await page.waitForTimeout(1500);
	await page.evaluate(
		({ i, coords }) => {
			const m = window.__map;
			const src = m.getSource("listings");
			const feats = (
				typeof src.getData === "function" ? src.getData() : src._data
			).features;
			m.fire("click", {
				features: [{ properties: feats[i].properties }],
				lngLat: m.unproject(coords),
				point: m.project(coords),
				type: "click",
				preventDefault() {},
				stopPropagation() {},
			});
		},
		{ i: cand.i, coords: cand.coords },
	);
	await page.waitForTimeout(1200);
	const text = await page.evaluate(() => {
		const el = document.querySelector(".mapboxgl-popup-content");
		return el ? el.innerText : null;
	});
	// Only a popup showing the candidate's own title is evidence about
	// its content; a sibling's popup proves nothing here.
	if (text && text.includes(cand.title.slice(0, 30))) {
		rcnOwnTitleSeen = true;
		rcnLastText = text;
		if (text.includes("RCN history:")) {
			rcnBlockSeen = true;
			break;
		}
	} else if (text) {
		rcnLastText = `sibling: ${text.slice(0, 80)}`;
	}
}
check(
	"inv- popup shows RCN price history",
	rcnBlockSeen,
	`tried ${rcnCandidates.length}, own-title ${rcnOwnTitleSeen}: ${rcnLastText.slice(0, 100)}`,
);

// 3. budujesie popup still renders
if (picks.bud) {
	const text = await clickAndPopup(picks.bud);
	check(
		"budujesie popup renders",
		popupMatches(text, picks.bud) && text.includes("Inwestycja"),
		JSON.stringify((text ?? "").slice(0, 120)),
	);
} else {
	check("budujesie popup renders", false, "no unique budujesie pick found");
}

// 3b. Building shells: the lazy creation fires on zoom-in (my refactor
// also moved the click/hover handlers into it), the simplified geometry
// still click-targets, and the building history popup renders.
const shellInfo = await page.evaluate(() => {
	const m = window.__map;
	const created = Boolean(m.getLayer("3d-building"));
	m.jumpTo({ center: [19.94, 50.06], zoom: 16 });
	return { created };
});
await page.waitForTimeout(5000);
const shellPts = await page.evaluate(() => {
	const m = window.__map;
	const r = document
		.querySelector(".mapboxgl-canvas-container")
		.getBoundingClientRect();
	const rendered = m.queryRenderedFeatures(
		[
			[200, 100],
			[1300, 850],
		],
		{ layers: ["3d-building"] },
	).length;
	const pts = [];
	for (let x = 250; x <= 1250 && pts.length < 3; x += 20) {
		for (let y = 120; y <= 820 && pts.length < 3; y += 20) {
			if (m.queryRenderedFeatures([x, y], { layers: ["3d-building"] }).length === 0)
				continue;
			if (
				m.queryRenderedFeatures([x, y], {
					layers: ["listings-circle", "komornik-listings"],
				}).length > 0
			)
				continue;
			pts.push({ x: x + r.left, y: y + r.top });
		}
	}
	return { rendered, pts };
});
let buildingPopup = null;
for (const p of shellPts.pts) {
	await page.mouse.click(p.x, p.y);
	await page.waitForTimeout(1500);
	buildingPopup = await page.evaluate(() => {
		const el = document.querySelector(".mapboxgl-popup-content");
		return el ? el.innerText : null;
	});
	if (
		buildingPopup &&
		(buildingPopup.includes("Historia transakcji") ||
			buildingPopup.includes("Brak transakcji"))
	)
		break;
}
// Address labels (trimmed /api/buildings/labels payload) still render.
const labelCount = await page.evaluate(() => {
	const m = window.__map;
	return m.queryRenderedFeatures(
		[
			[200, 100],
			[1300, 850],
		],
		{ layers: ["building-address-labels"] },
	).length;
});
check(
	"3d-building shells: lazy load + click popup",
	shellsAbsentAtStart &&
		shellInfo.created &&
		shellPts.rendered > 0 &&
		Boolean(
			buildingPopup &&
				(buildingPopup.includes("Historia transakcji") ||
					buildingPopup.includes("Brak transakcji")),
		),
	`absent@start=${shellsAbsentAtStart} created=${shellInfo.created} rendered=${shellPts.rendered} popup=${JSON.stringify((buildingPopup ?? "").slice(0, 60))}`,
);
check(
	"building address labels render",
	labelCount > 0,
	`labels rendered at z16: ${labelCount}`,
);

// 4. filters: days=7 + sale must not hide investment inventory
const before = await page.evaluate(() => {
	const src = window.__map.getSource("listings");
	const feats = (typeof src.getData === "function" ? src.getData() : src._data)
		.features;
	return {
		total: feats.length,
		inv: feats.filter((f) => String(f.properties.externalId).startsWith("inv-"))
			.length,
		bud: feats.filter((f) => f.properties.source === "budujesie").length,
	};
});
await page.locator("select").nth(1).selectOption("sale");
await page.locator("select").nth(2).selectOption("7");
await page.waitForTimeout(2000);
const after = await page.evaluate(() => {
	const src = window.__map.getSource("listings");
	const feats = (typeof src.getData === "function" ? src.getData() : src._data)
		.features;
	return {
		total: feats.length,
		inv: feats.filter((f) => String(f.properties.externalId).startsWith("inv-"))
			.length,
		bud: feats.filter((f) => f.properties.source === "budujesie").length,
	};
});
check(
	"days=7 + sale keeps inv- inventory",
	after.inv > 0 && after.inv === before.inv,
	`before=${before.inv} after=${after.inv}`,
);
check(
	"days=7 + sale keeps budujesie inventory",
	after.bud > 0 && after.bud === before.bud,
	`before=${before.bud} after=${after.bud}`,
);
check(
	"days=7 window actually filters offers",
	after.total < before.total,
	`before=${before.total} after=${after.total}`,
);

// 5. /listings shows the Realizacja caption
await page.goto("http://localhost:3000/listings", { waitUntil: "domcontentloaded" });
await page.waitForFunction(
	() => document.querySelectorAll("tbody tr").length > 10,
	null,
	{ timeout: 45000 },
);
const listingsText = await page.evaluate(() =>
	[...document.querySelectorAll("tbody tr")]
		.slice(0, 2500)
		.map((r) => r.innerText)
		.join("\n"),
);
check(
	"/listings shows Realizacja caption",
	/Realizacja: [^\n]+ · (w budowie|planowany termin minął)/.test(listingsText),
	(listingsText.match(/Realizacja: [^\n]+/)?.[0] ?? "none").slice(0, 80),
);

// 6. /listings: clicking an inv- row expands (valuation panel appears).
// inv- rows carry the Realizacja caption and a bare investment title
// (flat titles contain the ' — ' investment prefix).
const invRowClicked = await page.evaluate(() => {
	const rows = [...document.querySelectorAll("tbody tr")];
	const row = rows.find(
		(r) => r.innerText.includes("Realizacja:") && !r.innerText.includes("—"),
	);
	if (!row) return false;
	row.click();
	return true;
});
await page.waitForTimeout(3000);
const expandedText = await page.evaluate(() =>
	[...document.querySelectorAll("td")]
		.slice(0, 6000)
		.map((r) => r.innerText)
		.join("\n"),
);
check(
	"/listings inv- row expands",
	invRowClicked && /wycen/i.test(expandedText),
	invRowClicked ? "row clicked, panel text found" : "no inv- row visible",
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
