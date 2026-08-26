import { firefox } from "playwright-core";

const browser = await firefox.launch({ headless: true, executablePath: "/home/zdziszkee/.cache/ms-playwright/firefox-1538/firefox/firefox" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://localhost:3000/map", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const m = window.__map;
  return m && m.getSource("parcels") && m.isStyleLoaded();
}, { timeout: 45000 });
// Kazimierz / Podgorze block, zoomed enough for dzialka ID labels
await page.evaluate(() => {
  const m = window.__map;
  m.jumpTo({ center: [19.945, 50.0505], zoom: 15.6, pitch: 25, bearing: 0 });
});
await page.waitForTimeout(8000);
const diag = await page.evaluate(() => {
  const m = window.__map;
  const parcels = m.querySourceFeatures("parcels");
  const labels = m.queryRenderedFeatures(undefined, { layers: ["parcel-labels"] }).length;
  const blds = m.queryRenderedFeatures(undefined, { target: { featuresetId: "buildings", importId: "basemap" } });
  // restore a realistic highlight count: only API ids (already applied on load)
  const hi = blds.filter(f => f.state && f.state.highlight === true).length;
  return { parcels: parcels.length, labelsRendered: labels, bldHi: hi, layers: m.getStyle().layers.map(l => l.id).filter(id => id.startsWith("parcel")) };
});
console.log(JSON.stringify(diag));
await page.screenshot({ path: "/tmp/map-geoportal.png" });
await browser.close();
