CREATE TABLE `parcels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parcelId` text NOT NULL,
	`bboxMinLat` real NOT NULL,
	`bboxMinLng` real NOT NULL,
	`bboxMaxLat` real NOT NULL,
	`bboxMaxLng` real NOT NULL,
	`centroidLat` real NOT NULL,
	`centroidLng` real NOT NULL,
	`polygon` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parcels_parcelId_unique` ON `parcels` (`parcelId`);--> statement-breakpoint
CREATE INDEX `parcels_bbox_idx` ON `parcels` (`bboxMinLat`,`bboxMinLng`,`bboxMaxLat`,`bboxMaxLng`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `parcel_id` text;--> statement-breakpoint
CREATE INDEX `transactions_parcel_idx` ON `transactions` (`parcel_id`);