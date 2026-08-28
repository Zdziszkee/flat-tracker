import { chromium } from "playwright-core";
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on("console", (m) => { const t = m.text(); if (t.includes("[val]")) console.log("[c]", t.slice(0, 200)); });
await page.goto("http://localhost:3000/map", { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => {
  const m = window.__map;
  return m && m.getSource("listings") && m.isStyleLoaded();
}, { timeout: 60000 });
await page.evaluate(() => {
  const m = window.__map;
  m.jumpTo({ center: [19.94, 50.06], zoom: 14, pitch: 0, bearing: 0 });
});
await page.waitForTimeout(6000);
const target = await page.evaluate(() => {
  const m = window.__map;
  const pts = m.queryRenderedFeatures(undefined, { layers: ["listings-circle"] })
    .filter((f) => f.properties?.id === 6722);
  if (pts.length === 0) return null;
  const px = m.project(pts[0].geometry.coordinates);
  const rect = document.querySelector(".mapboxgl-canvas-container").getBoundingClientRect();
  return { x: px.x + rect.left, y: px.y + rect.top };
});
console.log("target:", target);
if (target) {
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(1500);
  const has = await page.evaluate(() => !!document.getElementById("popup-valuation"));
  console.log("placeholder present:", has);
  await page.waitForTimeout(4000);
  const val = await page.evaluate(() =>
    document.getElementById("popup-valuation")?.textContent.replace(/\s+/g, " ").slice(0, 300) ?? "GONE",
  );
  console.log("valuation:", val);
  await page.screenshot({ path: "/tmp/map-val.png" });
}
await browser.close();
