import { useQuery } from "@tanstack/react-query";

import type { ListingsResponse } from "#/types/listing";

/** Shared list feed. One query key keeps map and listings on the same data. */
export function useListings() {
	return useQuery<ListingsResponse>({
		queryKey: ["listings"],
		queryFn: () => fetch("/api/listings").then((r) => r.json()),
		staleTime: 60_000,
	});
}
