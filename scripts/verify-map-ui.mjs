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
			m && m.getLayer("3d-building") && m.isStyleLoaded() && m.getSource("listings")
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

// Features with unique coordinates (no sibling row to steal the click).
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

// 2. inv- building popup: amber Inwestycja label + Realizacja line
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
const listingsText = await page.evaluate(() => document.body.innerText);
check(
	"/listings shows Realizacja caption",
	/Realizacja: [^\n]+ · (w budowie|planowany termin minął)/.test(listingsText),
	(listingsText.match(/Realizacja: [^\n]+/)?.[0] ?? "none").slice(0, 80),
);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
