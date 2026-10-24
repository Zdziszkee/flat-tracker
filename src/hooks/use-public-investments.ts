import { useQuery } from "@tanstack/react-query";

export interface PublicInvestmentProperties {
	id: number;
	name: string;
	category: string;
	categoryLabel: string;
	status: string;
	statusLabel: string;
	description: string | null;
	url: string | null;
	year: number | null;
	city: string | null;
	region: string | null;
}

export interface PublicInvestmentFeature {
	type: "Feature";
	geometry: { type: "Point"; coordinates: [number, number] };
	properties: PublicInvestmentProperties;
}

export interface PublicInvestmentCollection {
	type: "FeatureCollection";
	features: PublicInvestmentFeature[];
}

/**
 * Planned/completed city investments, shared by the map category and the
 * listings table. Same source the map layer draws, so the count and the rows
 * can never disagree.
 */
export function usePublicInvestments(enabled = true) {
	return useQuery<PublicInvestmentCollection>({
		queryKey: ["public-investments"],
		queryFn: () => fetch("/api/public-investments").then((r) => r.json()),
		enabled,
		staleTime: 5 * 60_000,
	});
}
