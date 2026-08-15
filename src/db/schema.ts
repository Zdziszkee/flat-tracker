import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const todos = sqliteTable("todos", {
	id: integer({ mode: "number" }).primaryKey({
		autoIncrement: true,
	}),
	title: text().notNull(),
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

/**
 * A building (budynek) from OpenStreetMap, used as the anchor point for
 * map visualisations. Listings and transactions both reference a building
 * when a reliable match is found.
 */
export const buildings = sqliteTable("buildings", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	osmId: integer({ mode: "number" }).notNull().unique(),
	lat: real().notNull(),
	lng: real().notNull(),
	/** Approximate street address when known from OSM tags or reverse geocoding. */
	address: text(),
	/** OSM tags of interest (e.g. addr:street, building=apartments), JSON string. */
	tags: text(),
	/** GeoJSON geometry (polygon) of the building footprint, JSON string. */
	geometry: text(),
	createdAt: integer("created_at", { mode: "timestamp" }).default(
		sql`(unixepoch())`,
	),
});

/** A flat listing scraped from a listings portal (otodom, olx, ...). */
export const listings = sqliteTable(
	"listings",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		source: text().notNull(),
		/** Portal-specific stable ad id (otodom id, olx id). */
		externalId: text().notNull(),
		url: text().notNull(),
		title: text().notNull(),
		price: real(),
		pricePerM2: real(),
		areaM2: real(),
		rooms: integer({ mode: "number" }),
		floor: text(),
		district: text(),
		/** Street address parsed from the feed (e.g. "Jakuba Bojki 12"), used
		 * to geocode portals that hide coordinates. */
		address: text(),
		/** Raw ad description, used as an address-mining fallback when the
		 * portal exposes no structured address. */
		description: text(),
		/** Nullable because some portals (otodom list view) hide coordinates. */
		lat: real(),
		lng: real(),
		/** The building this offer was assigned to (see crawler/geocode.ts). */
		buildingId: integer("building_id").references(() => buildings.id),
		/** When the ad was created on the portal, if exposed. */
		listedAt: integer("listed_at", { mode: "timestamp" }),
		scrapedAt: integer("scraped_at", { mode: "timestamp" }).notNull(),
	},
	(t) => [
		uniqueIndex("listings_source_external_idx").on(t.source, t.externalId),
		index("listings_building_idx").on(t.buildingId),
	],
);

/**
 * Historical transaction prices from the Polish Rejestr Cen Nieruchomości
 * (RCN), declassified and free since 2026-02-13. Krakow city publishes a GML
 * export at https://rzeczoznawca.eco.um.krakow.pl/RCN/1261_RCN.zip
 */
export const transactions = sqliteTable(
	"transactions",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		/** RCN oznaczenieTransakcji (unique per notarial act entry). */
		transactionId: text().notNull().unique(),
		date: integer({ mode: "timestamp" }).notNull(),
		price: real().notNull(),
		pricePerM2: real(),
		areaM2: real(),
		rooms: integer({ mode: "number" }),
		floor: text(),
		street: text(),
		streetNumber: text(),
		district: text(),
		/** 1 = rynek pierwotny (primary), 2 = rynek wtórny (secondary). */
		market: integer({ mode: "number" }),
		lat: real(),
		lng: real(),
		buildingId: integer("building_id").references(() => buildings.id),
		importedAt: integer("imported_at", { mode: "timestamp" }).default(
			sql`(unixepoch())`,
		),
	},
	(t) => [index("transactions_building_idx").on(t.buildingId)],
);

/**
 * Local copy of OSM building footprints for Krakow, built from a Geofabrik
 * extract. Used for fast, dependency-free point-in-polygon matching of
 * transactions (the public Overpass API is too rate-limited for 80k+ points).
 */
export const osmBuildings = sqliteTable(
	"osm_buildings",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		osmId: integer({ mode: "number" }).notNull().unique(),
		bboxMinLat: real().notNull(),
		bboxMinLng: real().notNull(),
		bboxMaxLat: real().notNull(),
		bboxMaxLng: real().notNull(),
		centroidLat: real().notNull(),
		centroidLng: real().notNull(),
		/** Polygon ring as JSON array of {lat, lng}. */
		polygon: text().notNull(),
		address: text(),
		tags: text(),
	},
	(t) => [
		index("osm_buildings_bbox_idx").on(
			t.bboxMinLat,
			t.bboxMinLng,
			t.bboxMaxLat,
			t.bboxMaxLng,
		),
	],
);
