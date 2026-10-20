DROP INDEX `transactions_region_date_idx`;--> statement-breakpoint
CREATE INDEX `transactions_region_date_idx` ON `transactions` (`date`,`pricePerM2`,`parcel_id`) WHERE region is not null;