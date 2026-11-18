import { sql } from "drizzle-orm";
import {
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { REGION_CASE_SQL, REGION_PREDICATE_SQL } from "./region.ts";

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

/**
 * Planned / completed public investments (roads, schools, parks, sport,
 * culture) that are not real-estate listings. Imported from the city's
 * published My Maps KML; the map draws them as a separate, toggleable
 * layer and the listings table does not see them.
 */
export const publicInvestments = sqliteTable(
	"public_investments",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		source: text().notNull(),
		externalId: text().notNull(),
		name: text().notNull(),
		/** road | rail | school | park | sport | culture | health | other */
		category: text().notNull(),
		/** planned | in_progress | completed */
		status: text().notNull(),
		description: text(),
		url: text(),
		lat: real(),
		lng: real(),
		/** GeoJSON line/polygon when the source publishes one (points today). */
		geometry: text(),
		/** Planned or actual delivery year, when the source states one. */
		year: integer({ mode: "number" }),
		city: text(),
		region: text(),
		lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
		scrapedAt: integer("scraped_at", { mode: "timestamp" }).notNull(),
	},
	(table) => [
		uniqueIndex("public_investments_source_external_idx").on(
			table.source,
			table.externalId,
		),
		index("public_investments_status_idx").on(table.status),
		index("public_investments_category_idx").on(table.category),
	],
);

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
		/** Normalized location parts, split out of the free-text address. */
		city: text(),
		voivodeship: text(),
		postalCode: text("postal_code"),
		street: text(),
		streetNumber: text("street_number"),
		/** Land area for houses and plots, distinct from the built area. */
		plotAreaM2: real("plot_area_m2"),
		/** Plot designation: budowlana, rolna, rekreacyjna, siedliskowa, ... */
		plotType: text("plot_type"),
		/** Building construction type: block, apartment, house, townhouse, ... */
		buildingType: text("building_type"),
		/** Amenity flags promoted from the portal attribute blob. */
		hasBalcony: integer("has_balcony", { mode: "boolean" }),
		hasTerrace: integer("has_terrace", { mode: "boolean" }),
		hasGarden: integer("has_garden", { mode: "boolean" }),
		hasElevator: integer("has_elevator", { mode: "boolean" }),
		hasParking: integer("has_parking", { mode: "boolean" }),
		hasGarage: integer("has_garage", { mode: "boolean" }),
		hasBasement: integer("has_basement", { mode: "boolean" }),
		isFurnished: integer("is_furnished", { mode: "boolean" }),
		petsAllowed: integer("pets_allowed", { mode: "boolean" }),
		/** Monthly administrative fee / czynsz (rentals and some sales). */
		adminFee: real("admin_fee"),
		/** Refundable deposit / kaucja (rentals). */
		deposit: real(),
		priceNegotiable: integer("price_negotiable", { mode: "boolean" }),
		priceOnRequest: integer("price_on_request", { mode: "boolean" }),
		/** private | agency | developer */
		advertiserType: text("advertiser_type"),
		agencyName: text("agency_name"),
		/** Portal's own lifecycle status: active, reserved, sold, expired... */
		portalStatus: text("portal_status"),
		/** Portal's last modification time, distinct from scrapedAt. */
		sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp" }),
		/** New-development grouping (project id/title and developer name). */
		investmentId: text("investment_id"),
		investmentTitle: text("investment_title"),
		developer: text(),
		/** Auction/tender metadata (AMW, KOWR, KAS, gminne, PKP, ...). */
		auctionType: text("auction_type"),
		auctionDate: integer("auction_date", { mode: "timestamp" }),
		wadium: real(),
		seller: text(),
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
		/** Cadastral parcel containing the building, assigned by crawler/parcel-index.ts. */
		parcelId: text("parcel_id"),
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
		/**
		 * Construction completion ("realizacja") as published for
		 * new-development investments (investmap `finish.title`), e.g.
		 * "I kw. 2026". Planned while the project is underway, actual for
		 * delivered ones - the source does not distinguish.
		 */
		constructionEndLabel: text("construction_end_label"),
		/**
		 * Quarter-start date behind `constructionEndLabel` (investmap
		 * `finish.date`), e.g. "2026-01-01" for "I kw. 2026". Investmap
		 * publishes no construction start date and no status field, so
		 * there are no start/status columns - never guessed values.
		 */
		constructionEndDate: text("construction_end_date"),
		/**
		 * Derived, denormalized map/filter fields. They are recomputed in one
		 * pass after every crawl (`recomputeListingDerived`) instead of being
		 * classified and de-duplicated in JS on every `/api/listings` request:
		 *
		 * - `propertyKind`: `propertyKindOf` result (null = no evidence).
		 * - `isVisible`: false for hidden/deduped rows, so SQL can filter the
		 *   visible set directly.
		 * - `mapLat`/`mapLng`: the building centroid when the row is anchored
		 *   to one, otherwise its own coordinates.
		 * - `derivedAt`: marker for the pass; new crawl rows stay null until
		 *   the next recompute.
		 */
		propertyKind: text("property_kind"),
		isVisible: integer("is_visible", { mode: "boolean" })
			.notNull()
			.default(true),
		mapLat: real("map_lat"),
		mapLng: real("map_lng"),
		derivedAt: integer("derived_at", { mode: "timestamp" }),
	},
	(t) => [
		uniqueIndex("listings_source_external_idx").on(t.source, t.externalId),
		index("listings_building_idx").on(t.buildingId),
		index("listings_parcel_idx").on(t.parcelId),
		index("listings_district_listed_idx").on(t.district, t.listedAt),
		index("listings_source_listed_idx").on(t.source, t.listedAt),
		index("listings_price_m2_idx").on(t.pricePerM2),
		index("listings_area_idx").on(t.areaM2),
		index("listings_city_idx").on(t.city),
		index("listings_investment_idx").on(t.investmentId),
		index("listings_auction_date_idx").on(t.auctionDate),
		index("listings_active_idx").on(t.isActive),
		index("listings_derived_idx").on(t.derivedAt),
		index("listings_map_idx").on(t.mapLat, t.mapLng),
		index("listings_visible_source_kind_idx").on(
			t.isVisible,
			t.source,
			t.propertyKind,
		),
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
		/**
		 * Registry object family: a dwelling/unit, a whole building or land.
		 * GUGiK writes this explicitly from its three transaction tables;
		 * the Kraków apartment GML uses `unit`. NULL is legacy/ambiguous and
		 * must not be used as evidence for a segment-specific valuation.
		 */
		kind: text(),
		lat: real(),
		lng: real(),
		/**
		 * Tracked voivodeship this row sits in, derived from its coordinates
		 * (`src/db/region.ts` owns the boxes; `regionOf` is the in-process
		 * twin). NULL means "outside every tracked region", which is the case
		 * for the rest of the national RCN drain and for rows without
		 * geometry. Virtual, so adding it rewrote no rows, and every regional
		 * query filters on it instead of on coordinates.
		 */
		region: text().generatedAlwaysAs(sql.raw(REGION_CASE_SQL), {
			mode: "virtual",
		}),
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
		index("transactions_kind_date_idx").on(t.kind, t.date),
		/**
		 * Partial index over every tracked region (`src/db/region.ts`): the
		 * RCN import is national, so a regional aggregation would otherwise
		 * scan ~24M rows; this one holds the ~2.8M małopolskie + śląskie
		 * rows and is index-only for price/date series. The predicate must
		 * stay textually identical to `REGION_PREDICATE_SQL` (SQLite matches
		 * a partial index by expression identity), and it deliberately goes
		 * through the generated `region` column: an OR of the two boxes over
		 * `lat`/`lng` matches no index at all (measured, see region.ts).
		 */
		index("transactions_region_price_idx")
			.on(t.pricePerM2, t.date)
			.where(sql.raw(REGION_PREDICATE_SQL)),
		/**
		 * Date-first partial index for the per-powiat count in the analytics
		 * feed. The price-first index cannot drive `date >= ?` on its own, so
		 * the planner fell back to the global `parcel_id` index and scanned
		 * ~24M rows (measured ~35 s cold). This one holds only the ~3.4M
		 * regional rows and keeps the last-year count index-only. The price
		 * column is included so the monthly price/volume series can scan the
		 * date range instead of the whole price band.
		 */
		index("transactions_region_date_idx")
			.on(t.date, t.pricePerM2, t.parcelId)
			.where(sql.raw(REGION_PREDICATE_SQL)),
	],
);

/**
 * Quarterly, chain-linked property price indices used to bring historical
 * RCN comparables to the valuation date. One row is a complete
 * segment/geography/period observation; `strata` retains the area-band
 * medians that produced the link so the calculation stays auditable.
 */
export const priceIndices = sqliteTable(
	"price_indices",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		/** flat | flat_primary | flat_secondary | house | plot. */
		segment: text().notNull(),
		/** district | grid10 | region | external_city. */
		geographyType: text("geography_type").notNull(),
		/** Normalized district, grid key, region id or external city slug. */
		geographyKey: text("geography_key").notNull(),
		/** Quarter as YYYY-Qn, e.g. 2026-Q3. */
		period: text().notNull(),
		/** Chain index, 100 at the first usable quarter in this series. */
		indexValue: real("index_value").notNull(),
		/** Overall median for the observation, before area stratification. */
		medianPriceM2: real("median_price_m2"),
		sampleCount: integer("sample_count").notNull(),
		/** JSON: area-band medians and counts used for the chain link. */
		strata: text(),
		/** stratified_median | external. */
		method: text().notNull(),
		/** rcn | nbp. */
		source: text().notNull(),
		generatedAt: integer("generated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [
		uniqueIndex("price_indices_series_period_idx").on(
			t.segment,
			t.geographyType,
			t.geographyKey,
			t.period,
			t.source,
		),
		index("price_indices_lookup_idx").on(
			t.segment,
			t.geographyType,
			t.geographyKey,
			t.period,
		),
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
 * Local copy of OSM road centre lines from the same Geofabrik extracts as
 * the building index. Used to measure parcel road access and frontage
 * without calling Overpass per parcel.
 */
export const osmRoads = sqliteTable(
	"osm_roads",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		osmId: integer("osm_id", { mode: "number" }).notNull().unique(),
		/** OSM highway class: motorway, primary, residential, service, track... */
		roadClass: text("road_class").notNull(),
		surface: text(),
		name: text(),
		bboxMinLat: real("bbox_min_lat").notNull(),
		bboxMinLng: real("bbox_min_lng").notNull(),
		bboxMaxLat: real("bbox_max_lat").notNull(),
		bboxMaxLng: real("bbox_max_lng").notNull(),
		/** Polyline as JSON array of {lat, lng}. */
		points: text().notNull(),
	},
	(t) => [
		index("osm_roads_bbox_idx").on(
			t.bboxMinLat,
			t.bboxMinLng,
			t.bboxMaxLat,
			t.bboxMaxLng,
		),
		index("osm_roads_class_idx").on(t.roadClass),
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
		/** EGiB land-use class, e.g. B, Ba, R, Ls. */
		landUseClass: text("land_use_class"),
		/** EGiB register group, e.g. 1, 2, 7. */
		registerGroup: text("register_group"),
		/** Date of the EGiB snapshot that produced this row. */
		egibDataDate: text("egib_data_date"),
		/** Geometric area in hectares, computed from the polygon. */
		areaHa: real("area_ha"),
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
		/** One-line cause, shown in the /sources table. */
		error: text(),
		/** Full cause chain and stack traces, shown when the row is expanded. */
		errorDetail: text("error_detail"),
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
 * Derived physical and regulatory features for a cadastral parcel.
 * Populated by crawler/enrich-parcels.ts for parcels linked to a listing
 * or transaction. One row per parcel, recomputed when the source layers
 * change. Null means "not measured", never zero.
 */
export const parcelFeatures = sqliteTable(
	"parcel_features",
	{
		parcelId: text("parcel_id").primaryKey(),
		/** Polygon area in square metres. */
		areaM2: real("area_m2"),
		perimeterM: real("perimeter_m"),
		/** 4*pi*area/perimeter^2, 1.0 for a circle. */
		compactness: real("compactness"),
		/** Boundary length within 5 m of a public road, metres. */
		frontageM: real("frontage_m"),
		/** Distance from the parcel boundary to the nearest public road, metres. */
		roadDistanceM: real("road_distance_m"),
		/** Highest-class road touching or nearest the parcel. */
		roadClass: text("road_class"),
		buildingCount: integer("building_count", { mode: "number" }),
		buildingAreaM2: real("building_area_m2"),
		/** Dominant OSM building subtype by footprint area. */
		buildingSubtype: text("building_subtype"),
		/** Share of building footprint area by subtype. */
		buildingResidentialRatio: real("building_residential_ratio"),
		buildingGarageRatio: real("building_garage_ratio"),
		buildingCommercialRatio: real("building_commercial_ratio"),
		/** Building footprint area divided by parcel area. */
		buildingCoverage: real("building_coverage"),
		maxFloors: integer("max_floors", { mode: "number" }),
		/** EGiB building count intersecting the parcel. */
		egibBuildingCount: integer("egib_building_count", { mode: "number" }),
		/** EGiB building footprint area intersecting the parcel. */
		egibBuildingAreaM2: real("egib_building_area_m2"),
		/** EGiB floor area where above-ground floors are published. */
		egibBuildingFloorAreaM2: real("egib_building_floor_area_m2"),
		/** Footprint-weighted above-ground floors, where published. */
		egibBuildingFloors: real("egib_building_floors"),
		/** Share of EGiB footprint classified as residential. */
		egibBuildingResidentialRatio: real("egib_building_residential_ratio"),
		/** EGiB footprint area divided by parcel area. */
		egibBuildingCoverage: real("egib_building_coverage"),
		landUseClass: text("land_use_class"),
		registerGroup: text("register_group"),
		/** 1 when the parcel has a WZ decision (decyzja o warunkach zabudowy). */
		zoningWz: integer("zoning_wz", { mode: "boolean" }),
		/** 1 when the parcel has no MPZP and no WZ. */
		zoningNoPlan: integer("zoning_no_plan", { mode: "boolean" }),
		/** Number of distinct MPZP/WZ labels intersecting the parcel. */
		zoningPlanCount: integer("zoning_plan_count", { mode: "number" }),
		/** Full label list as JSON. */
		zoningFlags: text("zoning_flags"),
		/** 1 when any part of the parcel is in a flood hazard zone. */
		floodRisk: integer("flood_risk", { mode: "boolean" }),
		slopeDeg: real("slope_deg"),
		elevationM: real("elevation_m"),
		/** Date of the source snapshot used for the regulatory layers. */
		sourceDataDate: text("source_data_date"),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	},
	(t) => [index("parcel_features_updated_idx").on(t.updatedAt)],
);

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

/**
 * Transparent daily alert score for one sale listing.
 *
 * The score is deterministic and versioned. Components are stored separately
 * so the UI can explain every alert without re-running the scoring engine.
 */
export const listingScores = sqliteTable(
	"listing_scores",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		scoreVersion: text("score_version").notNull(),
		segment: text().notNull(),
		region: text().notNull(),
		valueScore: real("value_score").notNull(),
		transitScore: real("transit_score").notNull(),
		greenScore: real("green_score").notNull(),
		propertyScore: real("property_score").notNull(),
		riskScore: real("risk_score").notNull(),
		totalScore: real("total_score").notNull(),
		confidence: real().notNull(),
		/** False when a segment eligibility rule rejects the offer. */
		eligible: integer({ mode: "boolean" }).notNull().default(true),
		rankPct: real("rank_pct"),
		discountPct: real("discount_pct"),
		fairPrice: real("fair_price"),
		fairM2: real("fair_m2"),
		askingPrice: real("asking_price"),
		/** Comparables behind the median used for the fair value. */
		compCount: integer("comp_count", { mode: "number" }).notNull().default(0),
		/** RCN transactions among those comparables. */
		compRcnCount: integer("comp_rcn_count", { mode: "number" })
			.notNull()
			.default(0),
		/** Top positive and negative score contributions, JSON array. */
		reasonsJson: text("reasons_json").notNull().default(sql`'[]'`),
		/** Raw amenity distances and shares, JSON object. */
		amenitiesJson: text("amenities_json").notNull().default(sql`'{}'`),
		/** Risk and data-quality flags, JSON array. */
		flagsJson: text("flags_json").notNull().default(sql`'[]'`),
		computedAt: integer("computed_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		expiresAt: integer("expires_at", { mode: "timestamp" }),
	},
	(t) => [
		uniqueIndex("listing_scores_listing_version_idx").on(
			t.listingId,
			t.scoreVersion,
		),
		index("listing_scores_version_total_idx").on(t.scoreVersion, t.totalScore),
		index("listing_scores_segment_region_idx").on(
			t.scoreVersion,
			t.segment,
			t.region,
			t.totalScore,
		),
	],
);

/**
 * One row per listing per day per channel. The unique index makes the daily
 * job idempotent: re-running it cannot send the same alert twice.
 */
export const listingAlerts = sqliteTable(
	"listing_alerts",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		listingId: integer("listing_id")
			.notNull()
			.references(() => listings.id),
		scoreId: integer("score_id")
			.notNull()
			.references(() => listingScores.id),
		alertDate: text("alert_date").notNull(),
		segment: text().notNull(),
		region: text().notNull(),
		rank: integer({ mode: "number" }).notNull(),
		score: real().notNull(),
		channel: text().notNull().default(sql`'in_app'`),
		status: text().notNull().default(sql`'pending'`),
		payloadJson: text("payload_json").notNull().default(sql`'{}'`),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		seenAt: integer("seen_at", { mode: "timestamp" }),
	},
	(t) => [
		uniqueIndex("listing_alerts_listing_date_channel_idx").on(
			t.listingId,
			t.alertDate,
			t.channel,
		),
		index("listing_alerts_date_rank_idx").on(t.alertDate, t.region, t.rank),
		index("listing_alerts_status_idx").on(t.status),
	],
);
