import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import osmPbf, { type OsmItem } from "osm-pbf-parser";
import RBush from "rbush";

import { db } from "#/db/index";
import { osmBuildings } from "#/db/schema";

/**
 * Local OSM building index for Krakow.
 *
 * The public Overpass API is too rate-limited for assigning ~84k RCN
 * transactions to buildings, so this module downloads a Geofabrik extract
 * of the małopolskie region, streams the PBF with osm-pbf-parser, keeps
 * building footprints inside the Krakow bounding box, and stores them in
 * the `osm_buildings` table. Matching is then a local point-in-polygon
 * query via an in-memory RBush, with zero network dependency.
 */

const PBF_URL = "https://download.geofabrik.de/europe/poland/malopolskie-latest.osm.pbf";
const DATA_DIR = "data/osm";
const PBF_PATH = `${DATA_DIR}/malopolskie.osm.pbf`;

/** Expanded Krakow bounding box (city proper + immediate suburbs). */
const BBOX = {
  minLat: 49.95,
  minLng: 19.75,
  maxLat: 50.15,
  maxLng: 20.25,
};

export interface OsmBuilding {
  osmId: number;
  bboxMinLat: number;
  bboxMinLng: number;
  bboxMaxLat: number;
  bboxMaxLng: number;
  centroidLat: number;
  centroidLng: number;
  polygon: Array<{ lat: number; lng: number }>;
  address: string | null;
  tags: Record<string, string> | null;
}

function centroid(ring: Array<{ lat: number; lng: number }>): {
  lat: number;
  lng: number;
} {
  let lat = 0;
  let lng = 0;
  for (const p of ring) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / ring.length, lng: lng / ring.length };
}

function formatAddress(tags: Record<string, string> | undefined): string | null {
  if (!tags) return null;
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  if (!street && !number) return null;
  return [street, number].filter(Boolean).join(" ");
}

async function downloadIfMissing(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await stat(PBF_PATH);
    console.log(`Using cached ${PBF_PATH}`);
    return;
  } catch {
    // fall through
  }
  console.log(`Downloading ${PBF_URL} ...`);
  const res = await fetch(PBF_URL, { signal: AbortSignal.timeout(600_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(
    Readable.fromWeb(res.body as never),
    createWriteStream(PBF_PATH),
  );
}

/** Stream the PBF, collect building ways in the Krakow bbox, resolve polygons. */
async function extractBuildings(): Promise<OsmBuilding[]> {
  // Pass 1: collect building ways (id, refs, tags) inside the bbox.
  const ways = new Map<
    number,
    { refs: number[]; tags: Record<string, string> }
  >();

  await new Promise<void>((resolve, reject) => {
    const osm = osmPbf();
    osm.on("data", (items: OsmItem[]) => {
      for (const item of items) {
        if (item.type !== "way") continue;
        const tags = (item.tags ?? {}) as Record<string, string>;
        if (!tags.building) continue;
        const refs = (item.refs ?? []) as number[];
        if (refs.length < 3) continue;
        ways.set(item.id as number, { refs, tags });
      }
    });
    osm.on("end", resolve);
    osm.on("error", reject);
    createReadStream(PBF_PATH).pipe(osm);
  });

  console.log(`building ways in extract: ${ways.size}`);

  // Pass 2: collect coordinates only for referenced nodes inside the bbox.
  const nodeCoords = new Map<number, { lat: number; lng: number }>();
  const needed = new Set<number>();
  for (const w of ways.values()) {
    for (const ref of w.refs) {
      needed.add(ref);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const osm = osmPbf();
    osm.on("data", (items: OsmItem[]) => {
      for (const item of items) {
        if (item.type !== "node") continue;
        const id = item.id as number;
        if (!needed.has(id)) continue;
        const lat = item.lat as number;
        const lng = item.lon as number;
        if (lat < BBOX.minLat || lat > BBOX.maxLat) continue;
        if (lng < BBOX.minLng || lng > BBOX.maxLng) continue;
        nodeCoords.set(id, { lat, lng });
      }
    });
    osm.on("end", resolve);
    osm.on("error", reject);
    createReadStream(PBF_PATH).pipe(osm);
  });

  console.log(`node coords kept: ${nodeCoords.size}`);

  // Build polygons, keep only buildings fully inside the bbox.
  const buildings: OsmBuilding[] = [];
  for (const [osmId, way] of ways) {
    const ring: Array<{ lat: number; lng: number }> = [];
    let inBbox = true;
    for (const ref of way.refs) {
      const c = nodeCoords.get(ref);
      if (!c) {
        inBbox = false;
        break;
      }
      ring.push(c);
    }
    if (!inBbox || ring.length < 3) continue;

    const c = centroid(ring);
    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;
    for (const p of ring) {
      minLat = Math.min(minLat, p.lat);
      minLng = Math.min(minLng, p.lng);
      maxLat = Math.max(maxLat, p.lat);
      maxLng = Math.max(maxLng, p.lng);
    }
    buildings.push({
      osmId,
      bboxMinLat: minLat,
      bboxMinLng: minLng,
      bboxMaxLat: maxLat,
      bboxMaxLng: maxLng,
      centroidLat: c.lat,
      centroidLng: c.lng,
      polygon: ring,
      address: formatAddress(way.tags),
      tags: way.tags,
    });
  }

  console.log(`buildings in bbox: ${buildings.length}`);
  return buildings;
}

/** Download the extract, parse it, and (re)build the osm_buildings table. */
export async function buildOsmIndex(): Promise<number> {
  await downloadIfMissing();
  const buildings = await extractBuildings();

  await db.delete(osmBuildings);
  const BATCH = 2000;
  for (let i = 0; i < buildings.length; i += BATCH) {
    const slice = buildings.slice(i, i + BATCH);
    await db.insert(osmBuildings).values(
      slice.map((b) => ({
        osmId: b.osmId,
        bboxMinLat: b.bboxMinLat,
        bboxMinLng: b.bboxMinLng,
        bboxMaxLat: b.bboxMaxLat,
        bboxMaxLng: b.bboxMaxLng,
        centroidLat: b.centroidLat,
        centroidLng: b.centroidLng,
        polygon: JSON.stringify(b.polygon),
        address: b.address,
        tags: b.tags ? JSON.stringify(b.tags) : null,
      })),
    );
  }
  console.log(`osm_buildings: ${buildings.length} rows inserted`);
  return buildings.length;
}

interface IndexedBuilding extends OsmBuilding {
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

let cached: RBush<IndexedBuilding> | null = null;

/** Load the local index from the DB (cached in memory for the process). */
export async function loadOsmIndex(): Promise<RBush<IndexedBuilding>> {
  if (cached) return cached;
  const rows = await db.select().from(osmBuildings);
  const tree = new RBush<IndexedBuilding>();
  const items: IndexedBuilding[] = rows.map((r) => ({
    id: r.id,
    osmId: r.osmId,
    bboxMinLat: r.bboxMinLat,
    bboxMinLng: r.bboxMinLng,
    bboxMaxLat: r.bboxMaxLat,
    bboxMaxLng: r.bboxMaxLng,
    centroidLat: r.centroidLat,
    centroidLng: r.centroidLng,
    polygon: JSON.parse(r.polygon) as Array<{ lat: number; lng: number }>,
    address: r.address,
    tags: r.tags ? (JSON.parse(r.tags) as Record<string, string>) : null,
    // RBush expects minX/minY/maxX/maxY (x = lng, y = lat).
    minX: r.bboxMinLng,
    minY: r.bboxMinLat,
    maxX: r.bboxMaxLng,
    maxY: r.bboxMaxLat,
  }));
  tree.load(items);
  cached = tree;
  console.log(`osm index loaded: ${items.length} buildings`);
  return tree;
}

function pointInPolygon(
  lat: number,
  lng: number,
  poly: Array<{ lat: number; lng: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng;
    const yi = poly[i].lat;
    const xj = poly[j].lng;
    const yj = poly[j].lat;
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Find the building containing the point; fall back to nearest centroid. */
export function matchPointLocal(
  tree: RBush<IndexedBuilding>,
  lat: number,
  lng: number,
  radiusM = 40,
): IndexedBuilding | null {
  // Query a small square around the point (radiusM ~ 0.0005 deg ≈ 55 m).
  const d = 0.0006;
  const candidates = tree.search({
    minX: lng - d,
    minY: lat - d,
    maxX: lng + d,
    maxY: lat + d,
  });

  // 1. True containment.
  for (const b of candidates) {
    if (pointInPolygon(lat, lng, b.polygon)) return b;
  }
  // 2. Nearest centroid within the radius.
  let best: IndexedBuilding | null = null;
  let bestDist = radiusM;
  for (const b of candidates) {
    const dist = haversineMeters(lat, lng, b.centroidLat, b.centroidLng);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}

function normStreet(s: string | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Street-aware matching for RCN transactions. RCN georeferenced points can
 * sit on the plot centroid tens of meters from the building footprint
 * (new developments), so beyond the exact 40 m fallback we accept a
 * building whose addr:street matches the transaction street within
 * `streetRadiusM` (default 150 m). Only used for transactions, whose
 * addresses come from the authoritative notarial records.
 */
export function matchPointStreetAware(
  tree: RBush<IndexedBuilding>,
  lat: number,
  lng: number,
  street: string | null,
  streetRadiusM = 150,
): IndexedBuilding | null {
  // 1-2. Exact containment / 40 m nearest, as before.
  const exact = matchPointLocal(tree, lat, lng, 40);
  if (exact) return exact;

  const d = 0.002; // ~220 m search box
  const candidates = tree.search({
    minX: lng - d,
    minY: lat - d,
    maxX: lng + d,
    maxY: lat + d,
  });

  const streetNorm = normStreet(street);
  let bestStreet: IndexedBuilding | null = null;
  let bestStreetDist = streetRadiusM;
  let bestAny: IndexedBuilding | null = null;
  let bestAnyDist = streetRadiusM;

  for (const b of candidates) {
    const dist = haversineMeters(lat, lng, b.centroidLat, b.centroidLng);
    if (dist >= bestStreetDist && dist >= bestAnyDist) continue;
    const addr = normStreet(b.address);
    if (streetNorm && addr.startsWith(streetNorm) && dist < bestStreetDist) {
      bestStreetDist = dist;
      bestStreet = b;
    }
    if (dist < bestAnyDist) {
      bestAnyDist = dist;
      bestAny = b;
    }
  }
  return bestStreet ?? bestAny;
}

export async function osmIndexReady(): Promise<boolean> {
	const rows = await db
		.select({ id: osmBuildings.id })
		.from(osmBuildings)
		.limit(1);
	return rows.length > 0;
}
