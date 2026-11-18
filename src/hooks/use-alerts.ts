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
		// The list is rebuilt while a crawl runs (every arrival batch, debounced
		// in the engine), so the page polls instead of showing a frozen day.
		staleTime: 15_000,
		refetchInterval: 30_000,
	});
}
