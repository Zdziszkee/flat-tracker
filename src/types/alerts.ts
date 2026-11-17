/** Shared shapes for the daily in-app alert list. */

import type { AlertSegment } from "#/lib/scoring/config";

export interface AlertReason {
	label: string;
	impact: number;
	direction: "positive" | "negative";
}

export interface AlertDto {
	id: number;
	alertDate: string;
	/** Wall-clock moment the alert row was appended, ISO 8601. */
	alertCreatedAt: string;
	rank: number;
	score: number;
	segment: AlertSegment;
	region: string;
	discountPct: number | null;
	fairPrice: number | null;
	fairM2: number | null;
	askingPrice: number | null;
	confidence: number;
	valueScore: number;
	transitScore: number;
	greenScore: number;
	propertyScore: number;
	riskScore: number;
	reasons: AlertReason[];
	flags: string[];
	amenities: Record<string, unknown> | null;
	/** Portal posting date of the offer, ISO 8601. */
	listedAt: string | null;
	/** When the crawler first stored the offer, ISO 8601. */
	firstSeenAt: string | null;
	/** True when the alert row is younger than 24 hours. */
	isFresh: boolean;
	/** Why the alert was raised (for example "fresh_arrival"); null when the
	 * stored payload does not say. */
	reason: string | null;
	listing: {
		id: number;
		source: string;
		title: string;
		url: string;
		price: number | null;
		pricePerM2: number | null;
		areaM2: number | null;
		rooms: number | null;
		floor: string | null;
		district: string | null;
		city: string | null;
		address: string | null;
		lat: number | null;
		lng: number | null;
		propertyKind: string | null;
		offerType: string;
		firstSeenAt: string | null;
	};
}

export interface AlertsResponse {
	date: string;
	/** Server time the response was assembled, ISO 8601. */
	generatedAt: string;
	/** Number of rows whose alert was created within the last 24 hours. */
	freshCount: number;
	alerts: AlertDto[];
	counts: {
		total: number;
		byRegion: Record<string, number>;
		bySegment: Record<string, number>;
	};
}
