CREATE TABLE `crawl_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`pages` integer,
	`new_count` integer,
	`updated_count` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `crawl_runs_source_started_idx` ON `crawl_runs` (`source`,`started_at`);--> statement-breakpoint
CREATE TABLE `listing_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	`price` real,
	`pricePerM2` real,
	`areaM2` real,
	`status` text,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `listing_history_listing_idx` ON `listing_history` (`listing_id`,`captured_at`);--> statement-breakpoint
ALTER TABLE `listings` ADD `market` text;--> statement-breakpoint
ALTER TABLE `listings` ADD `build_year` integer;--> statement-breakpoint
ALTER TABLE `listings` ADD `building_material` text;--> statement-breakpoint
ALTER TABLE `listings` ADD `floor_count` integer;--> statement-breakpoint
ALTER TABLE `listings` ADD `condition` text;--> statement-breakpoint
ALTER TABLE `listings` ADD `ownership` text;--> statement-breakpoint
ALTER TABLE `listings` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `listings` ADD `deactivated_at` integer;--> statement-breakpoint
ALTER TABLE `listings` ADD `is_active` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `listings_district_listed_idx` ON `listings` (`district`,`listed_at`);--> statement-breakpoint
CREATE INDEX `listings_source_listed_idx` ON `listings` (`source`,`listed_at`);--> statement-breakpoint
CREATE INDEX `listings_price_m2_idx` ON `listings` (`pricePerM2`);--> statement-breakpoint
CREATE INDEX `listings_area_idx` ON `listings` (`areaM2`);--> statement-breakpoint
CREATE INDEX `listings_active_idx` ON `listings` (`is_active`);--> statement-breakpoint
CREATE INDEX `transactions_district_date_idx` ON `transactions` (`district`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_price_m2_date_idx` ON `transactions` (`pricePerM2`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_building_date_idx` ON `transactions` (`building_id`,`date`);