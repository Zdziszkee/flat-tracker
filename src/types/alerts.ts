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
	alerts: AlertDto[];
	counts: {
		total: number;
		byRegion: Record<string, number>;
		bySegment: Record<string, number>;
	};
}
