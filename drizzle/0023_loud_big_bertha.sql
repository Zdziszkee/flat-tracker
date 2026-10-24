CREATE TABLE `price_indices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`segment` text NOT NULL,
	`geography_type` text NOT NULL,
	`geography_key` text NOT NULL,
	`period` text NOT NULL,
	`index_value` real NOT NULL,
	`median_price_m2` real,
	`sample_count` integer NOT NULL,
	`strata` text,
	`method` text NOT NULL,
	`source` text NOT NULL,
	`generated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_indices_series_period_idx` ON `price_indices` (`segment`,`geography_type`,`geography_key`,`period`,`source`);--> statement-breakpoint
CREATE INDEX `price_indices_lookup_idx` ON `price_indices` (`segment`,`geography_type`,`geography_key`,`period`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `kind` text;--> statement-breakpoint
-- The only non-GUGiK source is the Kraków apartment GML. GUGiK ids all
-- contain "-G/"; its remaining rows are classified only from positive
-- evidence, leaving ambiguous building/unit history NULL rather than
-- feeding it to the wrong valuation segment.
UPDATE `transactions` SET `kind` = 'unit'
WHERE `kind` IS NULL AND `transactionId` NOT LIKE '%-G/%';--> statement-breakpoint
UPDATE `transactions` SET `kind` = 'parcel'
WHERE `kind` IS NULL AND `parcel_id` IS NOT NULL;--> statement-breakpoint
-- GUGiK external ids end in _LOK for premises and _BUD for whole
-- buildings, including rows whose optional rooms/floor fields are empty.
UPDATE `transactions` SET `kind` = 'unit'
WHERE `kind` IS NULL AND `transactionId` LIKE '%_LOK';--> statement-breakpoint
UPDATE `transactions` SET `kind` = 'building'
WHERE `kind` IS NULL AND `transactionId` LIKE '%_BUD';--> statement-breakpoint
UPDATE `transactions` SET `kind` = 'unit'
WHERE `kind` IS NULL AND (`rooms` IS NOT NULL OR `floor` IS NOT NULL);--> statement-breakpoint
CREATE INDEX `transactions_kind_date_idx` ON `transactions` (`kind`,`date`);
