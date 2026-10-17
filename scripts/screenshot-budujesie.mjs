import { chromium } from "playwright-core";

// Screenshot the map at budujesie pin locations so the hard-hat icons can
// be visually verified (feature counts cannot prove pixels draw).
const spots = [
	{ name: "rakowicka-z16", lng: 19.95578675, lat: 50.07330756, zoom: 16.5 },
	{ name: "gregorzecka-z16", lng: 19.96544398, lat: 50.05702995, zoom: 16.5 },
	{ name: "overview-z12", lng: 19.945, lat: 50.06, zoom: 12 },
];

const browser = await chromium.launch({
	headless: true,
	executablePath: "/usr/bin/chromium",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
await page.goto("http://localhost:3000/map", { waitUntil: "domcontentloaded" });
await page.waitForFunction(
	() => {
		const m = window.__map;
		return m && m.isStyleLoaded() && m.getSource("listings");
	},
	null,
	{ timeout: 45000 },
);
await page.waitForTimeout(9000);
for (const s of spots) {
	await page.evaluate(
		({ lng, lat, zoom }) => {
			window.__map.jumpTo({ center: [lng, lat], zoom });
		},
		{ lng: s.lng, lat: s.lat, zoom: s.zoom },
	);
	await page.waitForTimeout(4000);
	const stats = await page.evaluate(() => {
		const m = window.__map;
		const rendered = m.queryRenderedFeatures(undefined, {
			layers: ["budujesie-listings"],
		}).length;
		const circles = m.queryRenderedFeatures(undefined, {
			layers: ["listings-circle"],
		}).length;
		return { budujesieRendered: rendered, circlesRendered: circles };
	});
	await page.screenshot({ path: `/tmp/map-${s.name}.png` });
	console.log(s.name, JSON.stringify(stats));
}
await browser.close();
