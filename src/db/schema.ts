import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { MALOPOLSKA_BBOX_SQL } from "./region.ts";

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
	/**
	 * Construction year: the average of the flat listings anchored to this
	 * building (otodom detail pages), else the OSM `start_date` tag.
	 * Maintained by `assign-buildings` (updateBuildingYears).
	 */
	buildYear: integer("build_year", { mode: "number" }),
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
		/** When this offer was first seen by the crawler (insert-only). Used
		 * as the "added" date when the portal exposes no posting date. */
		firstSeenAt: integer("first_seen_at", { mode: "timestamp" }),
		/** Heating type (ogrzewanie), e.g. "miejskie", "gazowe". */
		heatingType: text("heating_type"),
		/** Property type (typ), e.g. "mieszkanie", "kawalerka". */
		propertyType: text("property_type"),
		/** Extra portal attributes (ogrzewanie, typ, parking, winda, ...) as
		 * a JSON object string, captured without schema churn. */
		features: text(),
		/** Primary/secondary market ("primary"/"secondary"). */
		market: text(),
		/** Year the building was constructed. */
		buildYear: integer("build_year", { mode: "number" }),
		/** Building material (brick, concrete_plate, ...). */
		buildingMaterial: text("building_material"),
		/** Number of floors in the building. */
		floorCount: integer("floor_count", { mode: "number" }),
		/** Finish/construction state (to_renovation, finished, ...). */
		condition: text(),
		/** Ownership form (full_ownership, cooperative, ...). */
		ownership: text(),
		/** Last crawl that saw this offer still live. */
		lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
		/** When the offer disappeared from the portal (sold/withdrawn). */
		deactivatedAt: integer("deactivated_at", { mode: "timestamp" }),
		/** False once the offer is no longer present on the portal. */
		isActive: integer("is_active", { mode: "boolean" })
			.notNull()
			.default(sql`1`),
		/** Nullable because some portals (otodom list view) hide coordinates. */
		lat: real(),
		lng: real(),
		/** The building this offer was assigned to (see crawler/geocode.ts). */
		buildingId: integer("building_id").references(() => buildings.id),
		/** When the ad was created on the portal, if exposed. */
		listedAt: integer("listed_at", { mode: "timestamp" }),
		scrapedAt: integer("scraped_at", { mode: "timestamp" }).notNull(),
		/** Offer type: sale | long_term_rental | short_term_rental. */
		offerType: text("offer_type").notNull().default(sql`'sale'`),
		/** Price period for rentals: monthly | night (null for sale). */
		pricePeriod: text("price_period"),
		/** Minimum stay length in nights (short-term rentals). */
		minimumStayNights: integer("minimum_stay_nights", { mode: "number" }),
		/** Review score (Airbnb/Booking). */
		rating: real(),
		/** Number of reviews (Airbnb/Booking). */
		reviewsCount: integer("reviews_count", { mode: "number" }),
		/** Availability count over the next year (Airbnb availability_365). */
		availabilityCount: integer("availability_count", { mode: "number" }),
		/** Maximum guest capacity for short-term rentals. */
		maxGuests: integer("max_guests", { mode: "number" }),
		/** Bedroom count (short-term rentals, from Airbnb PDP overview). */
		bedrooms: integer({ mode: "number" }),
		/** Bed count (short-term rentals, from Airbnb PDP overview). */
		beds: integer({ mode: "number" }),
		/** Bathroom count (short-term rentals, may be fractional, e.g. 1.5). */
		bathrooms: real(),
		/** Parsed monthly utility/administrative fees for rentals (JSON: ogrzewanie, prad, woda, gaz, smieci). */
		utilities: text(),
	},
	(t) => [
		uniqueIndex("listings_source_external_idx").on(t.source, t.externalId),
		index("listings_building_idx").on(t.buildingId),
		index("listings_district_listed_idx").on(t.district, t.listedAt),
		index("listings_source_listed_idx").on(t.source, t.listedAt),
		index("listings_price_m2_idx").on(t.pricePerM2),
		index("listings_area_idx").on(t.areaM2),
		index("listings_active_idx").on(t.isActive),
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
		/** Cadastral parcel (RCN_Dzialka registry id) this transaction sits on. */
		parcelId: text("parcel_id"),
		importedAt: integer("imported_at", { mode: "timestamp" }).default(
			sql`(unixepoch())`,
		),
	},
	(t) => [
		index("transactions_building_idx").on(t.buildingId),
		index("transactions_parcel_idx").on(t.parcelId),
		index("transactions_district_date_idx").on(t.district, t.date),
		index("transactions_price_m2_date_idx").on(t.pricePerM2, t.date),
		index("transactions_building_date_idx").on(t.buildingId, t.date),
		/**
		 * Partial index over the region the app tracks (`src/db/region.ts`):
		 * the RCN import is national, so every regional aggregation would
		 * otherwise scan ~20M out-of-region rows. Partial means the index
		 * only holds małopolska rows (bounded) and SQLite only uses it for
		 * queries that carry the identical predicate — see the note there
		 * before editing this text.
		 */
		index("transactions_malopolska_price_idx")
			.on(t.pricePerM2, t.date)
			.where(sql.raw(MALOPOLSKA_BBOX_SQL)),
	],
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

/**
 * Local index of cadastral parcels (działki). Two sources feed it:
 * - 'rcn'  — RCN_Dzialka parsed from the Krakow RCN GML export (binds
 *   transactions to their true parcel via exact xlink refs)
 * - 'egib' — GUGiK KIEG zbiorcza WFS (ms:dzialki), filling the REST of
 *   małopolska region-wide; the same registry-id format
 *   (e.g. 126104_9.0090.101/6) lets both share one unique key, with RCN
 *   rows taking precedence (imported first, egib uses INSERT OR IGNORE).
 * Used to bind transactions to parcels and to render the parcel grid
 * (geoportal podział gruntów style) on the map.
 */
export const parcels = sqliteTable(
	"parcels",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		/** Full registry id, e.g. 126104_9.0090.101/6. */
		parcelId: text().notNull().unique(),
		bboxMinLat: real().notNull(),
		bboxMinLng: real().notNull(),
		bboxMaxLat: real().notNull(),
		bboxMaxLng: real().notNull(),
		centroidLat: real().notNull(),
		centroidLng: real().notNull(),
		/** Exterior ring as JSON array of {lat, lng}. */
		polygon: text().notNull(),
		/** Where the row came from: 'rcn' (Krakow RCN) or 'egib' (KIEG WFS). */
		source: text().notNull().default("rcn"),
		/** Cadastral precinct (obręb) name, from the KIEG feed. */
		obreb: text(),
		/** Commune (gmina) name, from the KIEG feed. */
		gmina: text(),
	},
	(t) => [
		index("parcels_bbox_idx").on(
			t.bboxMinLat,
			t.bboxMinLng,
			t.bboxMaxLat,
			t.bboxMaxLng,
		),
	],
);

/**
 * Price/attribute snapshots per listing, one row whenever a crawl observes
 * a change. Enables price-drop and time-on-market analytics.
 */
export const listingHistory = sqliteTable(
	"listing_history",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		capturedAt: integer("captured_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		price: real(),
		pricePerM2: real(),
		areaM2: real(),
		status: text(),
	},
	(t) => [index("listing_history_listing_idx").on(t.listingId, t.capturedAt)],
);

/**
 * One row per site crawl run, for crawler-health and data-freshness metrics.
 */
export const crawlRuns = sqliteTable(
	"crawl_runs",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		source: text().notNull(),
		startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
		finishedAt: integer("finished_at", { mode: "timestamp" }),
		pages: integer({ mode: "number" }),
		newCount: integer("new_count", { mode: "number" }),
		updatedCount: integer("updated_count", { mode: "number" }),
		error: text(),
	},
	(t) => [index("crawl_runs_source_started_idx").on(t.source, t.startedAt)],
);

/**
 * Latest availability/price snapshot per rental listing and night. Raw
 * observations live in `availabilityHistory`; this table is the upserted
 * "current calendar" used by the UI and occupancy queries.
 */
export const availability = sqliteTable(
	"availability",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		source: text().notNull(),
		/** Night date as YYYY-MM-DD. */
		date: text().notNull(),
		/** Canonical booking configuration, e.g. "7_nights_2_adults". */
		priceConfig: text("price_config")
			.notNull()
			.default(sql`'7_nights_2_adults'`),
		/** Raw nightly asking price from the calendar. */
		listedPrice: real("listed_price"),
		/** Total payable price for the canonical stay (fees/taxes included). */
		totalPrice: real("total_price"),
		/** Canonical stay length in nights. */
		stayNights: integer("stay_nights", { mode: "number" }),
		/** Realized-price proxy: totalPrice / stayNights. */
		effectiveNightlyPrice: real("effective_nightly_price"),
		taxes: real(),
		fees: real(),
		available: integer({ mode: "boolean" }).notNull().default(sql`1`),
		minimumNights: integer("minimum_nights", { mode: "number" }),
		capturedAt: integer("captured_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		uniqueIndex("availability_listing_date_config_idx").on(
			t.listingId,
			t.date,
			t.priceConfig,
		),
		index("availability_listing_date_idx").on(t.listingId, t.date),
		index("availability_date_idx").on(t.date),
	],
);

/**
 * Append-only price/availability observations per rental listing and night.
 * Kept so lead-time and realized-price analytics can reconstruct how a
 * night's price changed as the check-in date approached.
 */
export const availabilityHistory = sqliteTable(
	"availability_history",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		source: text().notNull(),
		date: text().notNull(),
		priceConfig: text("price_config").notNull(),
		listedPrice: real("listed_price"),
		totalPrice: real("total_price"),
		stayNights: integer("stay_nights", { mode: "number" }),
		effectiveNightlyPrice: real("effective_nightly_price"),
		taxes: real(),
		fees: real(),
		available: integer({ mode: "boolean" }).notNull(),
		minimumNights: integer("minimum_nights", { mode: "number" }),
		observedAt: integer("observed_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		index("availability_history_listing_date_idx").on(t.listingId, t.date),
		index("availability_history_date_observed_idx").on(t.date, t.observedAt),
	],
);

/**
 * Per-parcel land metadata harvested from the GUGiK RCN GeoPackages:
 * zoning/sposób użytkowania and ewidencyjna area (ha) for each działka
 * seen in a transaction. Enriches the parcel popup (type, size in ar).
 */
export const parcelMeta = sqliteTable("parcel_meta", {
	parcelId: text("parcel_id").primaryKey(),
	/** Sposób użytkowania, e.g. "B", "R", "Ł" (budowlana/rolna/łąka). */
	landUse: text("land_use"),
	/** Przeznaczenie w MPZP (zoning plan label). */
	zoning: text("zoning"),
	/** Ewidencyjna area in hectares (1 ha = 100 ar = 10 000 m²). */
	areaHa: real("area_ha"),
	gmina: text(),
	obreb: text(),
	updatedAt: integer("updated_at", { mode: "timestamp" })
		.notNull()
		.default(sql`(unixepoch())`),
});

/**
 * Monthly price aggregation per rental listing, folded from availability
 * after each calendar crawl. Used directly by the analytics UI.
 */
export const listingMonthlyPrice = sqliteTable(
	"listing_monthly_price",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		/** Month as YYYY-MM. */
		month: text().notNull(),
		avgListedPrice: real("avg_listed_price"),
		avgEffectiveNightlyPrice: real("avg_effective_nightly_price"),
		minPrice: real("min_price"),
		maxPrice: real("max_price"),
		sampleDays: integer("sample_days", { mode: "number" }),
		bookedNights: integer("booked_nights", { mode: "number" }),
		capturedAt: integer("captured_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		uniqueIndex("listing_monthly_price_listing_month_idx").on(
			t.listingId,
			t.month,
		),
		index("listing_monthly_price_month_idx").on(t.month),
	],
);

/**
 * Monthly occupancy per rental listing, derived from the latest
 * availability snapshots with blocked-vs-booked run classification:
 * short unavailable runs bounded by open nights are real bookings,
 * horizon-tail or very long runs are owner blocks / unopened months.
 */
export const listingOccupancy = sqliteTable(
	"listing_occupancy",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		/** Month as YYYY-MM. */
		month: text().notNull(),
		/** Nights observed for this listing-month. */
		sampleDays: integer("sample_days", { mode: "number" }),
		/** Classified as real bookings (bounded unavailable runs). */
		bookedNights: integer("booked_nights", { mode: "number" }),
		/** Owner blocks / unopened months (unbounded tail runs, long runs). */
		blockedNights: integer("blocked_nights", { mode: "number" }),
		/** Open (bookable) nights. */
		availableNights: integer("available_nights", { mode: "number" }),
		/** bookedNights / sampleDays (0..1). */
		occupancyRate: real("occupancy_rate"),
		/** Avg effective nightly over AVAILABLE nights (marketable price). */
		avgAvailablePrice: real("avg_available_price"),
		capturedAt: integer("captured_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		uniqueIndex("listing_occupancy_listing_month_idx").on(t.listingId, t.month),
		index("listing_occupancy_month_idx").on(t.month),
	],
);

/**
 * Per-listing × weekday price/occupancy stats (Mon=0 .. Sun=6), folded
 * from the same snapshots: weekend premiums and midweek dips per market.
 */
export const listingWeekdayStats = sqliteTable(
	"listing_weekday_stats",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		/** 0 = Monday .. 6 = Sunday. */
		weekday: integer("weekday", { mode: "number" }).notNull(),
		sampleDays: integer("sample_days", { mode: "number" }),
		avgEffectiveNightlyPrice: real("avg_effective_nightly_price"),
		bookedNights: integer("booked_nights", { mode: "number" }),
		availableNights: integer("available_nights", { mode: "number" }),
		capturedAt: integer("captured_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		uniqueIndex("listing_weekday_stats_listing_dow_idx").on(
			t.listingId,
			t.weekday,
		),
	],
);
