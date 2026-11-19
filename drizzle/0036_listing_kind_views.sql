drop view if exists listing_flats;
--> statement-breakpoint
create view listing_flats as
	select "id", "source", "externalId", "url", "title", "price", "pricePerM2", "areaM2", "rooms", "floor", "district", "address", "description", "first_seen_at", "heating_type", "property_type", "features", "market", "build_year", "building_material", "floor_count", "condition", "ownership", "city", "voivodeship", "postal_code", "street", "street_number", "building_type", "has_balcony", "has_terrace", "has_garden", "has_elevator", "has_parking", "has_garage", "has_basement", "is_furnished", "pets_allowed", "admin_fee", "deposit", "price_negotiable", "price_on_request", "advertiser_type", "agency_name", "portal_status", "source_updated_at", "investment_id", "investment_title", "developer", "auction_type", "auction_date", "wadium", "seller", "last_seen_at", "deactivated_at", "is_active", "lat", "lng", "building_id", "listed_at", "scraped_at", "offer_type", "price_period", "minimum_stay_nights", "rating", "reviews_count", "availability_count", "max_guests", "bedrooms", "beds", "bathrooms", "construction_end_label", "construction_end_date", "property_kind", "is_visible", "map_lat", "map_lng", "derived_at"
	from listings
	where property_kind = 'apartment';
--> statement-breakpoint
drop view if exists listing_houses;
--> statement-breakpoint
create view listing_houses as
	select "id", "source", "externalId", "url", "title", "price", "pricePerM2", "areaM2", "rooms", "floor", "district", "address", "description", "first_seen_at", "heating_type", "property_type", "features", "market", "build_year", "building_material", "floor_count", "condition", "ownership", "city", "voivodeship", "postal_code", "street", "street_number", "plot_area_m2", "plot_type", "building_type", "has_balcony", "has_terrace", "has_garden", "has_elevator", "has_parking", "has_garage", "has_basement", "is_furnished", "pets_allowed", "admin_fee", "deposit", "price_negotiable", "price_on_request", "advertiser_type", "agency_name", "portal_status", "source_updated_at", "investment_id", "investment_title", "developer", "auction_type", "auction_date", "wadium", "seller", "last_seen_at", "deactivated_at", "is_active", "lat", "lng", "building_id", "parcel_id", "listed_at", "scraped_at", "offer_type", "price_period", "minimum_stay_nights", "rating", "reviews_count", "availability_count", "max_guests", "bedrooms", "beds", "bathrooms", "utilities", "construction_end_label", "construction_end_date", "property_kind", "is_visible", "map_lat", "map_lng", "derived_at"
	from listings
	where property_kind = 'house';
--> statement-breakpoint
drop view if exists listing_plots;
--> statement-breakpoint
create view listing_plots as
	select "id", "source", "externalId", "url", "title", "price", "pricePerM2", "district", "address", "description", "first_seen_at", "property_type", "features", "market", "city", "voivodeship", "postal_code", "street", "street_number", "plot_area_m2", "plot_type", "admin_fee", "deposit", "price_negotiable", "price_on_request", "advertiser_type", "agency_name", "portal_status", "source_updated_at", "investment_id", "investment_title", "developer", "auction_type", "auction_date", "wadium", "seller", "last_seen_at", "deactivated_at", "is_active", "lat", "lng", "parcel_id", "listed_at", "scraped_at", "offer_type", "price_period", "minimum_stay_nights", "rating", "reviews_count", "availability_count", "max_guests", "bedrooms", "beds", "bathrooms", "utilities", "construction_end_label", "construction_end_date", "property_kind", "is_visible", "map_lat", "map_lng", "derived_at"
	from listings
	where property_kind = 'plot';
