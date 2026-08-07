CREATE TABLE `osm_buildings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`osmId` integer NOT NULL,
	`bboxMinLat` real NOT NULL,
	`bboxMinLng` real NOT NULL,
	`bboxMaxLat` real NOT NULL,
	`bboxMaxLng` real NOT NULL,
	`centroidLat` real NOT NULL,
	`centroidLng` real NOT NULL,
	`polygon` text NOT NULL,
	`address` text,
	`tags` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osm_buildings_osmId_unique` ON `osm_buildings` (`osmId`);--> statement-breakpoint
CREATE INDEX `osm_buildings_bbox_idx` ON `osm_buildings` (`bboxMinLat`,`bboxMinLng`,`bboxMaxLat`,`bboxMaxLng`);