import { useQuery } from "@tanstack/react-query";

import type { AlertsResponse } from "#/types/alerts";

export function useAlerts(filters: {
	date?: string;
	region?: string;
	segment?: string;
}) {
	const params = new URLSearchParams();
	if (filters.date) params.set("date", filters.date);
	if (filters.region) params.set("region", filters.region);
	if (filters.segment) params.set("segment", filters.segment);
	return useQuery<AlertsResponse>({
		queryKey: ["alerts", filters],
		queryFn: () =>
			fetch(`/api/alerts?${params.toString()}`).then((r) => r.json()),
		staleTime: 60_000,
	});
}
