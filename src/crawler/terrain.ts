/**
 * Terrain features from the public Copernicus DEM (GLO-30).
 *
 * GUGiK's NMT WMS/WCS requires an authorized session, but the same terrain
 * is published as open COG tiles on AWS Open Data. We cache the eight
 * 1-degree tiles that cover the tracked voivodeships and sample slope and
 * elevation at a parcel centroid.
 *
 * Build the cache once:
 *   bun run build:dem
 */

import { mkdir, stat, writeFile } from "node:fs/promises";

import { fromFile, type GeoTIFF, type GeoTIFFImage } from "geotiff";

const DATA_DIR = "data/dem";
const BASE = "https://copernicus-dem-30m.s3.amazonaws.com";

/** 1-degree tiles covering lat 49-51, lng 18-22. */
const TILE_NAMES = [
	"Copernicus_DSM_COG_10_N49_00_E018_00_DEM",
	"Copernicus_DSM_COG_10_N49_00_E019_00_DEM",
	"Copernicus_DSM_COG_10_N49_00_E020_00_DEM",
	"Copernicus_DSM_COG_10_N49_00_E021_00_DEM",
	"Copernicus_DSM_COG_10_N50_00_E018_00_DEM",
	"Copernicus_DSM_COG_10_N50_00_E019_00_DEM",
	"Copernicus_DSM_COG_10_N50_00_E020_00_DEM",
	"Copernicus_DSM_COG_10_N50_00_E021_00_DEM",
] as const;

type TileName = (typeof TILE_NAMES)[number];

function tileFor(lat: number, lng: number): TileName | null {
	const n = `${Math.floor(lat).toString().padStart(2, "0")}`;
	const e = `${Math.floor(lng).toString().padStart(3, "0")}`;
	const name = `Copernicus_DSM_COG_10_N${n}_00_E${e}_00_DEM` as TileName;
	return TILE_NAMES.includes(name) ? name : null;
}

function tilePath(name: TileName): string {
	return `${DATA_DIR}/${name}.tif`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Download any missing DEM tiles (~25 MB each). */
export async function downloadDemTiles(): Promise<number> {
	await mkdir(DATA_DIR, { recursive: true });
	let downloaded = 0;
	for (const name of TILE_NAMES) {
		const path = tilePath(name);
		if (await exists(path)) continue;
		const url = `${BASE}/${name}/${name}.tif`;
		console.log(`Downloading ${url} ...`);
		const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
		if (!res.ok) throw new Error(`DEM download failed: HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		await writeFile(path, buf);
		downloaded++;
	}
	return downloaded;
}

const tiffCache = new Map<TileName, GeoTIFF>();
const imageCache = new Map<TileName, GeoTIFFImage>();

async function loadImage(name: TileName): Promise<GeoTIFFImage | null> {
	const cached = imageCache.get(name);
	if (cached) return cached;
	const path = tilePath(name);
	if (!(await exists(path))) return null;
	let tiff = tiffCache.get(name);
	if (!tiff) {
		tiff = await fromFile(path);
		tiffCache.set(name, tiff);
	}
	const image = await tiff.getImage();
	imageCache.set(name, image);
	return image;
}

/** Elevation in metres at a point, or null outside the cached tiles. */
export async function elevationAt(
	lat: number,
	lng: number,
): Promise<number | null> {
	const name = tileFor(lat, lng);
	if (!name) return null;
	const image = await loadImage(name);
	if (!image) return null;
	const [minX, minY, maxX, maxY] = image.getBoundingBox();
	const width = image.getWidth();
	const height = image.getHeight();
	if (!(minX <= lng && lng <= maxX && minY <= lat && lat <= maxY)) return null;
	const px = Math.min(width - 1, Math.max(0, Math.floor(((lng - minX) / (maxX - minX)) * width)));
	const py = Math.min(
		height - 1,
		Math.max(0, Math.floor(((maxY - lat) / (maxY - minY)) * height)),
	);
	const data = await image.readRasters({
		window: [px, py, px + 1, py + 1],
		samples: [0],
	});
	const value = (data[0] as ArrayLike<number>)[0];
	if (!Number.isFinite(value)) return null;
	return value;
}

/** Elevation and slope in degrees at a point, sampled over ~30 m. */
export async function terrainAt(
	lat: number,
	lng: number,
): Promise<{ elevationM: number | null; slopeDeg: number | null }> {
	const center = await elevationAt(lat, lng);
	if (center === null) return { elevationM: null, slopeDeg: null };
	const dLat = 30 / 110_574;
	const dLng = 30 / (111_320 * Math.cos((lat * Math.PI) / 180));
	const [north, south, east, west] = await Promise.all([
		elevationAt(lat + dLat, lng),
		elevationAt(lat - dLat, lng),
		elevationAt(lat, lng + dLng),
		elevationAt(lat, lng - dLng),
	]);
	if (
		north === null ||
		south === null ||
		east === null ||
		west === null
	) {
		return { elevationM: center, slopeDeg: null };
	}
	const dzdx = (east - west) / (2 * dLng * 111_320 * Math.cos((lat * Math.PI) / 180));
	const dzdy = (north - south) / (2 * dLat * 110_574);
	const slope = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
	return { elevationM: center, slopeDeg: slope };
}

export async function demReady(): Promise<boolean> {
	for (const name of TILE_NAMES) {
		if (!(await exists(tilePath(name)))) return false;
	}
	return true;
}

async function main(): Promise<void> {
	const n = await downloadDemTiles();
	console.log(`DEM tiles downloaded: ${n}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/src/crawler/terrain.ts")) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
