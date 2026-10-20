import { sql } from "drizzle-orm";

import { all, CITY_CASE } from "./shared";

export interface OccupancyCityRow {
	city: string;
	occupancy: number;
	n: number;
}

export interface StrPriceRow {
	month: string;
	source: string;
	avgPrice: number;
}

export interface OccupancyMonthRow {
	month: string;
	occupancy: number;
}

export interface WeekdayRow {
	weekday: number;
	avgPrice: number;
	bookedShare: number;
}

export async function getStrOccupancyByCity(): Promise<OccupancyCityRow[]> {
	return all<OccupancyCityRow>(sql`
		SELECT ${CITY_CASE} AS city,
		       avg(o.occupancy_rate) AS occupancy,
		       count(*) AS n
		FROM listing_occupancy o
		JOIN listings l ON l.id = o.listing_id
		WHERE l.lat IS NOT NULL
		GROUP BY city
		HAVING count(*) >= 3
		ORDER BY occupancy DESC
	`);
}

export async function getStrPriceByMonth(): Promise<StrPriceRow[]> {
	return all<StrPriceRow>(sql`
		SELECT m.month AS month, l.source AS source,
		       avg(m.avg_effective_nightly_price) AS avgPrice
		FROM listing_monthly_price m
		JOIN listings l ON l.id = m.listing_id
		WHERE m.avg_effective_nightly_price IS NOT NULL
		  AND l.source IN ('airbnb', 'booking')
		GROUP BY m.month, l.source
		ORDER BY m.month
	`);
}

export async function getOccupancyByMonth(): Promise<OccupancyMonthRow[]> {
	return all<OccupancyMonthRow>(sql`
		SELECT month, avg(occupancy_rate) AS occupancy
		FROM listing_occupancy
		GROUP BY month ORDER BY month
	`);
}

export async function getWeekdayPremium(): Promise<WeekdayRow[]> {
	return all<WeekdayRow>(sql`
		SELECT weekday, avg(avg_effective_nightly_price) AS avgPrice,
		       avg(CASE WHEN sample_days > 0
		            THEN booked_nights * 1.0 / sample_days ELSE 0 END)
		         AS bookedShare
		FROM listing_weekday_stats
		WHERE avg_effective_nightly_price IS NOT NULL
		GROUP BY weekday ORDER BY weekday
	`);
}
