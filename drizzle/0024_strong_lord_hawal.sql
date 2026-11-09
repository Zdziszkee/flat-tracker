ALTER TABLE `listings` ADD `property_kind` text;--> statement-breakpoint
ALTER TABLE `listings` ADD `is_visible` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `listings` ADD `map_lat` real;--> statement-breakpoint
ALTER TABLE `listings` ADD `map_lng` real;--> statement-breakpoint
ALTER TABLE `listings` ADD `derived_at` integer;--> statement-breakpoint
CREATE INDEX `listings_derived_idx` ON `listings` (`derived_at`);--> statement-breakpoint
CREATE INDEX `listings_map_idx` ON `listings` (`map_lat`,`map_lng`);--> statement-breakpoint
CREATE INDEX `listings_visible_source_kind_idx` ON `listings` (`is_visible`,`source`,`property_kind`);