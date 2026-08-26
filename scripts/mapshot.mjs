import { firefox } from "playwright-core";

const browser = await firefox.launch({ headless: true, executablePath: "/home/zdziszkee/.cache/ms-playwright/firefox-1538/firefox/firefox" });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto("http://localhost:3000/map", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const m = window.__map;
  return m && m.getSource("parcels") && m.isStyleLoaded();
}, { timeout: 45000 });
// Fly to central Krakow where RCN history buildings + parcels are dense
await page.evaluate(() => {
  const m = window.__map;
  m.jumpTo({ center: [19.94, 50.0615], zoom: 15.5, pitch: 55, bearing: -25 });
});
await page.waitForTimeout(9000);
const diag = await page.evaluate(() => {
  const m = window.__map;
  const blds = m.queryRenderedFeatures(undefined, { target: { featuresetId: "buildings", importId: "basemap" } });
  return {
    zoom: m.getZoom(),
    feats: m.querySourceFeatures("parcels").length,
    bldRend: blds.length,
    bldHi: blds.filter(f => f.properties && f.properties.highlight === true).length,
    terrain: m.getTerrain(),
  };
});
console.log(JSON.stringify(diag));
await page.screenshot({ path: "/tmp/map-krakow.png" });
await browser.close();
