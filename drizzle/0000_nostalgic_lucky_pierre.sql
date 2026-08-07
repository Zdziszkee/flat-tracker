CREATE TABLE `buildings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`osmId` integer NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`address` text,
	`tags` text,
	`geometry` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `buildings_osmId_unique` ON `buildings` (`osmId`);--> statement-breakpoint
CREATE TABLE `listings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`externalId` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`price` real,
	`pricePerM2` real,
	`areaM2` real,
	`rooms` integer,
	`floor` text,
	`district` text,
	`lat` real,
	`lng` real,
	`building_id` integer,
	`listed_at` integer,
	`scraped_at` integer NOT NULL,
	FOREIGN KEY (`building_id`) REFERENCES `buildings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `listings_source_external_idx` ON `listings` (`source`,`externalId`);--> statement-breakpoint
CREATE INDEX `listings_building_idx` ON `listings` (`building_id`);--> statement-breakpoint
CREATE TABLE `todos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transactionId` text NOT NULL,
	`date` integer NOT NULL,
	`price` real NOT NULL,
	`pricePerM2` real,
	`areaM2` real,
	`rooms` integer,
	`floor` text,
	`street` text,
	`streetNumber` text,
	`district` text,
	`market` integer,
	`lat` real,
	`lng` real,
	`building_id` integer,
	`imported_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`building_id`) REFERENCES `buildings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_transactionId_unique` ON `transactions` (`transactionId`);--> statement-breakpoint
CREATE INDEX `transactions_building_idx` ON `transactions` (`building_id`);