CREATE TABLE `availability` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`source` text NOT NULL,
	`date` text NOT NULL,
	`price_config` text DEFAULT '7_nights_2_adults' NOT NULL,
	`listed_price` real,
	`total_price` real,
	`stay_nights` integer,
	`effective_nightly_price` real,
	`taxes` real,
	`fees` real,
	`available` integer DEFAULT 1 NOT NULL,
	`minimum_nights` integer,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `availability_listing_date_config_idx` ON `availability` (`listing_id`,`date`,`price_config`);--> statement-breakpoint
CREATE INDEX `availability_listing_date_idx` ON `availability` (`listing_id`,`date`);--> statement-breakpoint
CREATE INDEX `availability_date_idx` ON `availability` (`date`);--> statement-breakpoint
CREATE TABLE `availability_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`source` text NOT NULL,
	`date` text NOT NULL,
	`price_config` text NOT NULL,
	`listed_price` real,
	`total_price` real,
	`stay_nights` integer,
	`effective_nightly_price` real,
	`taxes` real,
	`fees` real,
	`available` integer NOT NULL,
	`minimum_nights` integer,
	`observed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `availability_history_listing_date_idx` ON `availability_history` (`listing_id`,`date`);--> statement-breakpoint
CREATE INDEX `availability_history_date_observed_idx` ON `availability_history` (`date`,`observed_at`);--> statement-breakpoint
CREATE TABLE `listing_monthly_price` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`month` text NOT NULL,
	`avg_listed_price` real,
	`avg_effective_nightly_price` real,
	`min_price` real,
	`max_price` real,
	`sample_days` integer,
	`booked_nights` integer,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_monthly_price_listing_month_idx` ON `listing_monthly_price` (`listing_id`,`month`);--> statement-breakpoint
CREATE INDEX `listing_monthly_price_month_idx` ON `listing_monthly_price` (`month`);--> statement-breakpoint
ALTER TABLE `listings` ADD `offer_type` text DEFAULT 'sale' NOT NULL;--> statement-breakpoint
ALTER TABLE `listings` ADD `price_period` text;--> statement-breakpoint
ALTER TABLE `listings` ADD `minimum_stay_nights` integer;--> statement-breakpoint
ALTER TABLE `listings` ADD `rating` real;--> statement-breakpoint
ALTER TABLE `listings` ADD `reviews_count` integer;--> statement-breakpoint
ALTER TABLE `listings` ADD `availability_count` integer;