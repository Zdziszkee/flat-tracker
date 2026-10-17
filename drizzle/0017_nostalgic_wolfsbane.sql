DROP INDEX `transactions_malopolska_price_idx`;--> statement-breakpoint
ALTER TABLE `transactions` ADD `region` text GENERATED ALWAYS AS (case when lat between 49.15 and 50.55 and lng between 19.05 and 21.45 then 'malopolskie' when lat between 49.35 and 51.02 and lng between 18.3 and 20.05 then 'slaskie' end) VIRTUAL;--> statement-breakpoint
CREATE INDEX `transactions_region_price_idx` ON `transactions` (`pricePerM2`,`date`) WHERE region is not null;--> statement-breakpoint
CREATE INDEX `transactions_malopolska_price_idx` ON `transactions` (`pricePerM2`,`date`) WHERE region = 'malopolskie';