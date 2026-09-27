import { chromium } from "playwright-core";

const BASE = "http://localhost:3000";
const browser = await chromium.launch({
	executablePath: "/usr/bin/chromium",
	args: ["--no-sandbox", "--use-gl=swiftshader", "--headless=new"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${BASE}/map`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".mapboxgl-canvas", { timeout: 60000 });
await page.waitForTimeout(8000);

const feat = await page.evaluate(() => {
	const w = window as unknown as {
		__map?: {
			querySourceFeatures: (s: string, o?: unknown) => unknown[];
			project: (c: [number, number]) => { x: number; y: number };
		};
	};
	const map = w.__map;
	if (!map) return { ok: false as const, reason: "no map handle" };
	const feats = map.querySourceFeatures("listings", {
		filter: ["==", ["get", "source"], "budujesie"],
	}) as {
		properties: Record<string, unknown>;
		geometry: { coordinates: [number, number] };
	}[];
	// Prefer a feature whose features JSON carries >2 posts.
	const rich = feats.find((f) => {
		const raw = f.properties.features;
		try {
			const posts = (JSON.parse(String(raw)) as { posts?: unknown[] }).posts;
			return Array.isArray(posts) && posts.length > 2;
		} catch {
			return false;
		}
	});
	const pick = rich ?? feats[0];
	return {
		ok: true as const,
		count: feats.length,
		title: pick?.properties.title,
		featuresProp: String(pick?.properties.features).slice(0, 220),
		point: pick ? map.project(pick.geometry.coordinates) : null,
	};
});
console.log("picked:", JSON.stringify(feat).slice(0, 400));

if (feat.ok && feat.point) {
	await page.mouse.click(feat.point.x, feat.point.y);
	await page.waitForTimeout(2500);
	const popup = await page.evaluate(() => {
		const el = document.querySelector(".mapboxgl-popup-content");
		return el ? el.innerHTML : "(no popup)";
	});
	console.log("--- popup html ---");
	console.log(popup);
	console.log("--- end popup ---");
}

await page.goto(`${BASE}/listings`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("table", { timeout: 60000 });
await page.waitForTimeout(3000);
const clicked = await page.evaluate(() => {
	const rows = [...document.querySelectorAll("tbody tr")];
	const target = rows.find((r) => (r.textContent ?? "").includes("budujesie"));
	if (!target) return "(no budujesie row)";
	(target as HTMLElement).click();
	return "clicked: " + (target.textContent ?? "").slice(0, 80);
});
console.log("listings click:", clicked);
await page.waitForTimeout(1500);
const panelHtml = await page.evaluate(() => {
	const cells = [...document.querySelectorAll("td")];
	const hit = cells.find((c) => (c.textContent ?? "").includes("Komentarze"));
	return hit
		? (hit.textContent?.slice(0, 200) ?? "")
		: "(no comments panel)";
});
console.log("listings panel:", panelHtml);
await page.screenshot({ path: "tmp-verify-listings.png", fullPage: false });

await browser.close();
