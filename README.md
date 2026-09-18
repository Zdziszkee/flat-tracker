# Flat Tracker Kraków

Tracker of Krakow flat sale listings. Scrapes otodom.pl and olx.pl, joins the
offers with historical transaction prices from Poland's Rejestr Cen
Nieruchomości (RCN), and shows every offer on a map anchored to its
OpenStreetMap building.

## Quick start

```bash
npm install
npm run dev                 # web app at http://localhost:3000
```

That is the whole setup. No `.env.local`, no manual migration step:

- `dev.db` is created on first use and every migration in `drizzle/` is
  applied automatically (same for `npm run ...` scripts).
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
npx playwright install chromium   # browser binaries are not part of npm install
npx camoufox fetch                # anti-detect browser for Booking.com's DataDome
```

Skip it and those two sources just report a failed crawl on `/sources`; every
other source is unaffected.

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
npm run assign-buildings   # re-anchor listings/transactions onto OSM buildings
```

The import runs as part of every refresh (`importRcn()` in the pipeline, plus
the region-wide GUGiK per-powiat packages via `npm run import:rcn-gugik`). It
only takes sales of apartments (`rodzajTransakcji=1`, `funkcjaLokalu=1`) and
stores price, price/m², area, rooms, floor, address, date and coordinates.
Re-runs are idempotent: a HEAD request skips the download when the registry
hasn't changed.

## Stack

TanStack Start (React 19) · Crawlee 3 + Cheerio · SQLite + Drizzle ·
Effect TS pipeline · OSM/Overpass geocoding · mapbox-gl (3D buildings)

**Note:** `better-sqlite3` does not work under Bun. All DB scripts must run
with Node via tsx (`npm run ...`), never `bun run ...`.

## Documentation

See [AGENTS.md](AGENTS.md) for the architecture, the RCN GML structure, how
to add a new listing site adapter, and Effect TS conventions.
