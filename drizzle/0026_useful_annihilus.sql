CREATE TABLE `osm_roads` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`osm_id` integer NOT NULL,
	`road_class` text NOT NULL,
	`surface` text,
	`name` text,
	`bbox_min_lat` real NOT NULL,
	`bbox_min_lng` real NOT NULL,
	`bbox_max_lat` real NOT NULL,
	`bbox_max_lng` real NOT NULL,
	`points` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `osm_roads_osm_id_unique` ON `osm_roads` (`osm_id`);--> statement-breakpoint
CREATE INDEX `osm_roads_bbox_idx` ON `osm_roads` (`bbox_min_lat`,`bbox_min_lng`,`bbox_max_lat`,`bbox_max_lng`);--> statement-breakpoint
CREATE INDEX `osm_roads_class_idx` ON `osm_roads` (`road_class`);