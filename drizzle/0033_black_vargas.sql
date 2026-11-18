CREATE TABLE `listing_facts` (
	`listing_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`source_hash` text NOT NULL,
	`facts_json` text DEFAULT '{}' NOT NULL,
	`extracted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`listing_id`) REFERENCES `listings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `listing_facts_extracted_idx` ON `listing_facts` (`extracted_at`);