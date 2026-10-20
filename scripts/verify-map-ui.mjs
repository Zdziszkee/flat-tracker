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
// Generous: a dev server booting with its background crawl (camoufox
// browsers, CPU-saturating) can take >30 s to serve a cold page.
page.setDefaultTimeout(120_000);
await page.goto("http://localhost:3000/map", { waitUntil: "domcontentloaded", timeout: 120_000 });
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

/** Filters are URL-backed; reload with a search string and wait for pins. */
async function gotoMap(search = "") {
	await page.goto(`http://localhost:3000/map${search}`, {
		waitUntil: "domcontentloaded",
		timeout: 120_000,
	});
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
			return d && d.features && d.features.length > 0;
		},
		null,
		{ timeout: 45000 },
	);
	await page.waitForTimeout(1200);
}

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
let invLabelSeen = false;
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
		if (text.includes("Inwestycja")) invLabelSeen = true;
		if (text.includes("RCN history:")) {
			rcnBlockSeen = true;
			break;
		}
	} else if (text) {
		rcnLastText = `sibling: ${text.slice(0, 80)}`;
	}
}
check(
	"inv- popup shows Inwestycja label",
	invLabelSeen,
	rcnLastText.slice(0, 100),
);
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
// Address labels (trimmed /api/buildings/labels payload) still render. The
// label source resolves after the shell source; wait for the layer to
// produce a hit instead of sampling the immediate next frame.
await page
	.waitForFunction(
		() =>
			window.__map.getLayer("building-address-labels") &&
			window.__map.queryRenderedFeatures(
				[
					[200, 100],
					[1300, 850],
				],
				{ layers: ["building-address-labels"] },
			).length > 0,
		null,
		{ timeout: 15000 },
	)
	.catch(() => {});
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

// The loading overlay must clear once pins actually render (it used to
// leak uncaught layer-query errors that could kill its poll loop).
const overlayGone = await page.evaluate(
	() => !document.body.innerText.includes("Ładowanie mapy"),
);
check("loading overlay clears after render", overlayGone);

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
await gotoMap("?offerType=sale&days=7");
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

// 4b. property-kind filter (dom / mieszkanie / działka): choosing
// "Działka" must leave only plot pins and cut the count. Start from a
// clean filter state — the sale/7d window would hide older auction plots.
await gotoMap("");
const beforeKind = await page.evaluate(() => {
	const src = window.__map.getSource("listings");
	const feats = (typeof src.getData === "function" ? src.getData() : src._data)
		.features;
	return feats.length;
});
await gotoMap("?kind=plot");
const plotState = await page.evaluate(() => {
	const src = window.__map.getSource("listings");
	const feats = (typeof src.getData === "function" ? src.getData() : src._data)
		.features;
	return {
		total: feats.length,
		wrong: feats.filter((f) => f.properties.propertyKind !== "plot").length,
	};
});
check(
	"property-kind filter shows only plots",
	plotState.total > 0 &&
		plotState.total < beforeKind &&
		plotState.wrong === 0,
	`all=${beforeKind} plots=${plotState.total} wrong=${plotState.wrong}`,
);
await gotoMap("");

// 4c. "Kolej" overlay: railway lines + stations render and the toggle
// hides them (queryRenderedFeatures sees only visible layers). Frame
// Kraków Główny so stations are actually in view.
const railBefore = await page.evaluate(() => {
	const m = window.__map;
	m.jumpTo({ center: [19.9435, 50.0685], zoom: 12 });
	return { jumped: true };
});
await page.waitForTimeout(2500);
const railState = await page.evaluate(() => {
	const m = window.__map;
	return {
		layers: Boolean(m.getLayer("railway-line")) && Boolean(m.getLayer("railway-station")),
		lines: m.queryRenderedFeatures([[0, 0], [2800, 1500]], { layers: ["railway-line"] }).length,
		stations: m.queryRenderedFeatures([[0, 0], [2800, 1500]], { layers: ["railway-station"] }).length,
	};
});
await page.locator('input[type="checkbox"]').nth(1).uncheck();
await page.waitForTimeout(800);
const railHidden = await page.evaluate(
	() =>
		window.__map.queryRenderedFeatures([[0, 0], [2800, 1500]], {
			layers: ["railway-line", "railway-station"],
		}).length,
);
await page.locator('input[type="checkbox"]').nth(1).check();
check(
	"railway overlay renders and toggles",
	railState.layers &&
		railState.lines > 0 &&
		railState.stations > 0 &&
		railHidden === 0,
	`lines=${railState.lines} stations=${railState.stations} hidden=${railHidden}`,
);

// 5. /listings shows the Realizacja caption. Scan every row in-page: the
// table holds tens of thousands of rows and shipping its text over CDP is
// slow and eventually oversized.
await page.goto("http://localhost:3000/listings?source=investmap", {
	waitUntil: "domcontentloaded",
});
await page.waitForFunction(
	() => document.querySelectorAll("tbody tr").length > 10,
	null,
	{ timeout: 45000 },
);
const captionSample = await page.evaluate(() => {
	const re =
		/Realizacja: [^\n]+ · (w budowie|planowany termin minął)/;
	for (const tr of document.querySelectorAll("tbody tr")) {
		const m = tr.innerText.match(re);
		if (m) return m[0];
	}
	return null;
});
check(
	"/listings shows Realizacja caption",
	Boolean(captionSample),
	(captionSample ?? "none").slice(0, 80),
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
const panelFound = await page.evaluate(() => {
	for (const td of document.querySelectorAll("td")) {
		if (/wycen/i.test(td.innerText)) return true;
	}
	return false;
});
check(
	"/listings inv- row expands",
	invRowClicked && panelFound,
	invRowClicked ? `row clicked, panel=${panelFound}` : "no inv- row visible",
);

// 7. Table pagination: the feed is server-side now, so the next page must
// come from a new request and update the page counter.
const nextButton = page.getByRole("button", { name: "Następna" });
const canAdvance = await nextButton.isEnabled();
if (canAdvance) await nextButton.click();
await page
	.waitForFunction(() => /Strona 2 z/.test(document.body.innerText), null, {
		timeout: 15000,
	})
	.catch(() => {});
const pageLabel = await page.evaluate(
	() => document.body.innerText.match(/Strona \d+ z \d+/)?.[0] ?? "none",
);
check(
	"/listings pagination advances",
	canAdvance && pageLabel.startsWith("Strona 2 z"),
	pageLabel,
);

// 8. Changing a filter drops `page` from the URL, so a filtered view always
// starts on page 1 (and the next page ... button cannot request a stale one).
await page.getByRole("combobox", { name: "Rodzaj nieruchomości" }).click();
await page.getByRole("option", { name: /^Mieszkanie/ }).click();
await page
	.waitForFunction(() => /Strona 1 z/.test(document.body.innerText), null, {
		timeout: 15000,
	})
	.catch(() => {});
const afterFilter = await page.evaluate(() => {
	const url = new URL(window.location.href);
	return {
		pageParam: url.searchParams.get("page"),
		kind: url.searchParams.get("kind"),
		label: document.body.innerText.match(/Strona \d+ z \d+/)?.[0] ?? "none",
	};
});
check(
	"/listings filter change resets page",
	afterFilter.pageParam === null &&
		afterFilter.kind === "apartment" &&
		afterFilter.label.startsWith("Strona 1 z"),
		JSON.stringify(afterFilter),
);

// 9. A hand-edited out-of-range page is clamped to the last page by both the
// API and the footer, instead of rendering an empty table with "Strona 10000".
await page.goto("http://localhost:3000/listings?source=investmap&page=9999", {
	waitUntil: "domcontentloaded",
});
await page
	.waitForFunction(
		() => {
			const m = document.body.innerText.match(
				/Strona (\d+) z (\d+) · (\d+) ofert/,
			);
			return m && Number(m[3]) > 0 && Number(m[1]) === Number(m[2]);
		},
		null,
		{ timeout: 45000 },
	)
	.catch(() => {});
const clampedPage = await page.evaluate(() => {
	const m = document.body.innerText.match(/Strona (\d+) z (\d+)/);
	return m ? { page: Number(m[1]), total: Number(m[2]) } : null;
});
check(
	"/listings out-of-range page clamps to last page",
	clampedPage !== null &&
		clampedPage.page === clampedPage.total &&
		clampedPage.page < 1000,
	JSON.stringify(clampedPage),
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
