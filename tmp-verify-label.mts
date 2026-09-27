import { chromium } from "playwright-core";
const api = await (await fetch("http://localhost:3000/api/listings")).json();
const rows = (api.listings ?? api) as Array<{ source: string; title: string; features?: string }>;
const lastByTitle = new Map<string, string | null>();
for (const r of rows) {
  if (r.source !== "budujesie") continue;
  let last: string | null = null;
  try { last = JSON.parse(r.features ?? "{}").lastPostAt ?? null; } catch {}
  lastByTitle.set(r.title, last);
}
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox", "--use-gl=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:3000/map", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => (window as any).__map?.isStyleLoaded?.() ?? false, null, { timeout: 45000 }).catch(() => {});
await page.waitForTimeout(5000);
await page.evaluate(() => {
  const map = (window as any).__map;
  const layerId = map.getStyle().layers.find((l: any) => /bud/i.test(l.id))?.id;
  for (const l of map.getStyle().layers) {
    if (l.id === layerId) continue;
    if (l.type === "circle" || l.type === "symbol") { try { map.setLayoutProperty(l.id, "visibility", "none"); } catch {} }
  }
});
await page.waitForTimeout(1200);
const picked = await page.evaluate(() => {
  const map = (window as any).__map;
  const layerId = map.getStyle().layers.find((l: any) => /bud/i.test(l.id))?.id;
  return map.queryRenderedFeatures(undefined, { layers: [layerId] }).slice(0, 80)
    .map((f: any) => f.properties?.title).filter(Boolean);
});
let checkedActive = 0, checkedStale = 0, bad = 0, skipped = 0;
for (const title of picked) {
  const last = lastByTitle.get(title);
  if (last === undefined) continue;
  const fresh = last != null && Date.now() - Date.parse(last) < 548 * 24 * 3600e3;
  const fired = await page.evaluate((t) => {
    const map = (window as any).__map;
    const layerId = map.getStyle().layers.find((l: any) => /bud/i.test(l.id))?.id;
    const f = map.queryRenderedFeatures(undefined, { layers: [layerId] }).find((x: any) => x.properties?.title === t);
    if (!f) return false;
    const c = f.geometry.coordinates;
    const ev = { lngLat: { lng: c[0], lat: c[1] }, features: [f], originalEvent: { clientX: 200, clientY: 200, stopPropagation() {} }, point: map.project(c), target: map, type: "click" };
    for (const h of map._listeners?.click ?? []) {
      const fn = typeof h === "function" ? h : h?.fn;
      if (typeof fn === "function") { try { fn.call(map, ev); } catch {} }
    }
    return true;
  }, title);
  if (!fired) continue;
  await page.waitForTimeout(300);
  const text = (await page.locator(".mapboxgl-popup-content").first().textContent().catch(() => "")) ?? "";
  if (!text.includes(title.slice(0, 30))) { skipped++; continue; } // overlap contamination
  const hasBud = /Inwestycja w budowie/.test(text);
  const hasStamp = /ostatnia aktywność/.test(text);
  const ok = fresh ? hasBud && !hasStamp : hasStamp && !hasBud;
  if (!ok) { bad++; console.log("MISMATCH", title.slice(0, 40), "| last:", last, "| popup:", text.replace(/\s+/g, " ").slice(0, 130)); }
  else if (fresh) checkedActive++; else checkedStale++;
  if (checkedActive >= 3 && checkedStale >= 3) break;
}
console.log("labels ok | active:", checkedActive, "stale:", checkedStale, "| mismatches:", bad, "| skipped(overlap):", skipped);
await browser.close();
