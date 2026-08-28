CREATE TABLE `listing_occupancy` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`month` text NOT NULL,
	`sample_days` integer,
	`booked_nights` integer,
	`blocked_nights` integer,
	`available_nights` integer,
	`occupancy_rate` real,
	`avg_available_price` real,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_occupancy_listing_month_idx` ON `listing_occupancy` (`listing_id`,`month`);--> statement-breakpoint
CREATE INDEX `listing_occupancy_month_idx` ON `listing_occupancy` (`month`);--> statement-breakpoint
CREATE TABLE `listing_weekday_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`weekday` integer NOT NULL,
	`sample_days` integer,
	`avg_effective_nightly_price` real,
	`booked_nights` integer,
	`available_nights` integer,
	`captured_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_weekday_stats_listing_dow_idx` ON `listing_weekday_stats` (`listing_id`,`weekday`);