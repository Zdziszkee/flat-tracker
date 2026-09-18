# Flat Tracker Kraków

Tracker of Krakow flat sale listings. Scrapes otodom.pl and olx.pl, joins the
offers with historical transaction prices from Poland's Rejestr Cen
Nieruchomości (RCN), and shows every offer on a map anchored to its
OpenStreetMap building.

## Quick start

```bash
bun install
bun run dev                 # web app at http://localhost:3000
```

That is the whole setup. No `.env.local`, no manual migration step:

- `dev.db` is created on first use and every migration in `drizzle/` is
  applied automatically (same for `bun run ...` scripts).
- The dev server then kicks off a background crawl of every portal, so the
  database fills up on its own; the hourly scheduled task keeps it current
  (`/sources` shows progress and has a "Refresh now" button).
- Heavy reference layers (RCN transaction registry ~2 GB, the Geofabrik OSM
  extract, GUGiK per-powiat packages) download on the first run too and are
  cached under `data/`.

Optional: `cp .env.local.example .env.local` to pin `DATABASE_URL` (default
`dev.db`), set `BETTER_AUTH_SECRET`, or add `VITE_MAPBOX_TOKEN`. The map
needs a public Mapbox token — free tier covers 50k map loads/month; restrict
the token to your app domain in the Mapbox dashboard. Without it the map page
says the token is missing, everything else works.

Optional, for the browser-rendered portals (booking.com, licytacje.komornik.pl):

```bash
bunx camoufox-js fetch   # ~660 MB anti-detect Firefox; also what gets past Booking's DataDome
```

`bunx playwright install chromium` works as a lighter fallback browser (the
rendered sources use whichever is present), but camoufox is the one the
portals are fought with.

Skip it and the rendered sources (booking, licytacje.komornik.pl, plus the
airbnb/booking calendar tasks) log one line and report a failed crawl on
`/sources` (`CRAWL_DEBUG=1` prints the raw error); every other source is
unaffected.

Then open:

- `/` — overview
- `/map` — offers on a map, colored by price/m², popups show RCN history for the building
- `/listings` — table of all offers
- `/api/listings` — JSON behind the map

## Historical transaction prices (RCN)

Poland declassified the Rejestr Cen Nieruchomości (notarial transaction
prices) in February 2026. Krakow publishes a GML export:

`https://rzeczoznawca.eco.um.krakow.pl/RCN/1261_RCN.zip` (~2 GB)

```bash
bun run assign-buildings   # re-anchor listings/transactions onto OSM buildings
```

The import runs as part of every refresh (`importRcn()` in the pipeline, plus
the region-wide GUGiK per-powiat packages via `bun run import:rcn-gugik`). It
only takes sales of apartments (`rodzajTransakcji=1`, `funkcjaLokalu=1`) and
stores price, price/m², area, rooms, floor, address, date and coordinates.
Re-runs are idempotent: a HEAD request skips the download when the registry
hasn't changed.

## Stack

TanStack Start (React 19) · Crawlee 3 + Cheerio · SQLite + Drizzle ·
Effect TS pipeline · OSM/Overpass geocoding · mapbox-gl (3D buildings)

**Note:** bun is the toolchain here (`bun install`, `bunx`, `bun run <script>`);
`npx` is not used. The one hard rule: `better-sqlite3` crashes under bun's own
runtime, so never execute a DB-touching file *with* bun (`bun src/...`). The
package scripts go through tsx/Node, so `bun run assign-buildings` is correct.

## Documentation

See [AGENTS.md](AGENTS.md) for the architecture, the RCN GML structure, how
to add a new listing site adapter, and Effect TS conventions.
