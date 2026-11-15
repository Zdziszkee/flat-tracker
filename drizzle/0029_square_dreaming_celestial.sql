CREATE TABLE `listing_alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`score_id` integer NOT NULL,
	`alert_date` text NOT NULL,
	`segment` text NOT NULL,
	`region` text NOT NULL,
	`rank` integer NOT NULL,
	`score` real NOT NULL,
	`channel` text DEFAULT 'in_app' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`seen_at` integer,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`score_id`) REFERENCES `listing_scores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_alerts_listing_date_channel_idx` ON `listing_alerts` (`listing_id`,`alert_date`,`channel`);--> statement-breakpoint
CREATE INDEX `listing_alerts_date_rank_idx` ON `listing_alerts` (`alert_date`,`region`,`rank`);--> statement-breakpoint
CREATE INDEX `listing_alerts_status_idx` ON `listing_alerts` (`status`);--> statement-breakpoint
CREATE TABLE `listing_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`listing_id` integer NOT NULL,
	`score_version` text NOT NULL,
	`segment` text NOT NULL,
	`region` text NOT NULL,
	`value_score` real NOT NULL,
	`transit_score` real NOT NULL,
	`green_score` real NOT NULL,
	`property_score` real NOT NULL,
	`risk_score` real NOT NULL,
	`total_score` real NOT NULL,
	`confidence` real NOT NULL,
	`rank_pct` real,
	`discount_pct` real,
	`fair_price` real,
	`fair_m2` real,
	`asking_price` real,
	`reasons_json` text DEFAULT '[]' NOT NULL,
	`amenities_json` text DEFAULT '{}' NOT NULL,
	`flags_json` text DEFAULT '[]' NOT NULL,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listing_scores_listing_version_idx` ON `listing_scores` (`listing_id`,`score_version`);--> statement-breakpoint
CREATE INDEX `listing_scores_version_total_idx` ON `listing_scores` (`score_version`,`total_score`);--> statement-breakpoint
CREATE INDEX `listing_scores_segment_region_idx` ON `listing_scores` (`score_version`,`segment`,`region`,`total_score`);