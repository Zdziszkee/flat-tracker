CREATE TABLE `parcel_features` (
	`parcel_id` text PRIMARY KEY NOT NULL,
	`area_m2` real,
	`perimeter_m` real,
	`compactness` real,
	`frontage_m` real,
	`road_distance_m` real,
	`road_class` text,
	`building_count` integer,
	`building_area_m2` real,
	`building_coverage` real,
	`max_floors` integer,
	`land_use_class` text,
	`register_group` text,
	`zoning_wz` integer,
	`zoning_no_plan` integer,
	`zoning_plan_count` integer,
	`zoning_flags` text,
	`flood_risk` integer,
	`slope_deg` real,
	`elevation_m` real,
	`source_data_date` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `parcel_features_updated_idx` ON `parcel_features` (`updated_at`);--> statement-breakpoint
ALTER TABLE `listings` ADD `parcel_id` text;--> statement-breakpoint
CREATE INDEX `listings_parcel_idx` ON `listings` (`parcel_id`);--> statement-breakpoint
ALTER TABLE `parcels` ADD `land_use_class` text;--> statement-breakpoint
ALTER TABLE `parcels` ADD `register_group` text;--> statement-breakpoint
ALTER TABLE `parcels` ADD `egib_data_date` text;--> statement-breakpoint
ALTER TABLE `parcels` ADD `area_ha` real;