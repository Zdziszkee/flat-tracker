# Flat Tracker Kraków

Tracker of Krakow flat sale listings. Scrapes otodom.pl and olx.pl, joins the
offers with historical transaction prices from Poland's Rejestr Cen
Nieruchomości (RCN), and shows every offer on a map anchored to its
OpenStreetMap building.

## Quick start

```bash
npm install
cp .env.local.example .env.local   # set DATABASE_URL, VITE_MAPBOX_TOKEN
npm run db:migrate          # create SQLite DB from migrations
npm run crawl:all           # crawl all Krakow sources
npm run assign-buildings    # match listings to OSM buildings (local index)
npm run dev                 # web app at http://localhost:3000
```

The map needs a public Mapbox token (`VITE_MAPBOX_TOKEN`) — free tier
covers 50k map loads/month; restrict the token to your app domain in the
Mapbox dashboard.

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
npm run import-rcn     # downloads once, streams the GML, imports apartment sales
npm run assign-buildings
```

The importer only takes sales of apartments (`rodzajTransakcji=1`,
`funkcjaLokalu=1`) and stores price, price/m², area, rooms, floor, address,
date and coordinates. Re-runs are idempotent.

## Stack

TanStack Start (React 19) · Crawlee 3 + Cheerio · SQLite + Drizzle ·
Effect TS pipeline · Overpass API geocoding · react-leaflet + OSM tiles

**Note:** `better-sqlite3` does not work under Bun. All DB scripts must run
with Node via tsx (`npm run ...`), never `bun run ...`.

## Documentation

See [AGENTS.md](AGENTS.md) for the architecture, the RCN GML structure, how
to add a new listing site adapter, and Effect TS conventions.
