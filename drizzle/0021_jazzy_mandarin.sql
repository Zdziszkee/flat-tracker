CREATE TABLE `public_investments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`externalId` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`status` text NOT NULL,
	`description` text,
	`url` text,
	`lat` real,
	`lng` real,
	`geometry` text,
	`year` integer,
	`city` text,
	`region` text,
	`last_seen_at` integer,
	`scraped_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_investments_source_external_idx` ON `public_investments` (`source`,`externalId`);--> statement-breakpoint
CREATE INDEX `public_investments_status_idx` ON `public_investments` (`status`);--> statement-breakpoint
CREATE INDEX `public_investments_category_idx` ON `public_investments` (`category`);