import { chromium } from "playwright-core";

// Usage: node scripts/mapshot.mjs [lng lat zoom] — defaults to Krowodrza.
const [lng, lat, zoom] = process.argv.slice(2).map(Number) ?? [];

const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://localhost:3000/map", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const m = window.__map;
  return m && m.getLayer("3d-building") && m.getSource("parcels") && m.isStyleLoaded();
}, { timeout: 45000 });
await page.evaluate(({ lng, lat, zoom }) => {
  const m = window.__map;
  m.jumpTo({ center: [lng, lat], zoom, pitch: 0, bearing: 0 });
}, { lng: lng ?? 19.955, lat: lat ?? 50.09, zoom: zoom ?? 16.5 });
await page.waitForTimeout(5000);
await page.screenshot({ path: "/tmp/map-shot.png" });

// Click the first rendered parcel to verify the popup.
const target = await page.evaluate(() => {
  const m = window.__map;
  const parcels = m.queryRenderedFeatures(undefined, { layers: ["parcel-fill"] });
  if (parcels.length === 0) return null;
  const centroid = (f) => {
    const ring = f.geometry.coordinates[0];
    let x = 0, y = 0;
    for (const c of ring) { x += c[0]; y += c[1]; }
    return [x / ring.length, y / ring.length];
  };
  return m.project(centroid(parcels[0]));
});
if (target) {
  const v = await page.evaluate(({ x, y }) => {
    const r = document.querySelector(".mapboxgl-canvas-container").getBoundingClientRect();
    return { x: x + r.left, y: y + r.top };
  }, target);
  await page.mouse.click(v.x, v.y);
  await page.waitForTimeout(2500);
  const popup = await page.evaluate(
    () => document.querySelector(".mapboxgl-popup-content")?.textContent?.replace(/\s+/g, " ").slice(0, 140) ?? "NO POPUP",
  );
  console.log("parcel click ->", popup);
  await page.screenshot({ path: "/tmp/map-shot-popup.png" });
}
console.log("done");
await browser.close();
