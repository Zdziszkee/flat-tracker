CREATE TABLE `parcel_meta` (
	`parcel_id` text PRIMARY KEY NOT NULL,
	`land_use` text,
	`zoning` text,
	`area_ha` real,
	`gmina` text,
	`obreb` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
