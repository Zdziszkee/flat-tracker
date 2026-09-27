import * as cheerio from "cheerio";
import { budujesieAdapter } from "./src/crawler/sites/budujesie.ts";
import { db } from "./src/db/index.ts";
import { sql } from "drizzle-orm";

const UA = { "User-Agent": "flat-tracker/1.0 (research; contact via repo)" };
const ids = new Set(
  (db.all(sql`SELECT "externalId" FROM listings WHERE source='budujesie'`) as Array<{ externalId: string }>).map((r) => r.externalId),
);
console.log("DB rows:", ids.size);

// Walk the last list page: it must be the true end, and every topic on it
// must exist in the DB.
const last = await fetch("https://budujesie.pl/viewforum.php?f=5&start=1275", { headers: UA });
const $last = cheerio.load(await last.text());
const lastRows = $last("li.row").toArray()
  .map((el) => budujesieAdapter.parseListingCard?.($last as never, el as never) ?? null)
  .filter((l) => l != null);
const nextHref = $last('a:contains("Następny"), a[rel="next"], li.pagination-next a').attr("href");
console.log("last page rows:", lastRows.length, "| next-page link:", nextHref ?? "none (true end)");
const missingOnLast = lastRows.filter((l) => !ids.has(l.externalId));
console.log("last-page topics missing from DB:", missingOnLast.length, missingOnLast.map((l) => l.externalId).join(",") || "-");

// And the deep-middle page already pinned by the validator.
let liveTotal = 0;
for (const start of [0, 25, 500, 1000, 1275]) {
  const res = await fetch(`https://budujesie.pl/viewforum.php?f=5&start=${start}`, { headers: UA });
  const $ = cheerio.load(await res.text());
  const rows = $("li.row").toArray()
    .map((el) => budujesieAdapter.parseListingCard?.($ as never, el as never) ?? null)
    .filter((l) => l != null);
  const absent = rows.filter((l) => !ids.has(l.externalId)).length;
  liveTotal += rows.length;
  console.log(`page start=${start}: live=${rows.length} absent-from-DB=${absent}`);
}
