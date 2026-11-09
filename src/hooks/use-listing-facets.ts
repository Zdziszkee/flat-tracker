import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { DaysFilter } from "#/lib/listing-features";
import type { ListingFacetsResponse } from "#/types/listing";

/**
 * Source/kind counts for the filter bar. The map page no longer downloads the
 * whole offer feed just to compute facets: this is a small SQL aggregation and
 * the feed itself is viewport-limited.
 */
export function useListingFacets(days: DaysFilter) {
	return useQuery<ListingFacetsResponse>({
		queryKey: ["listings", "facets", days],
		queryFn: () =>
			fetch(`/api/listings?view=facets&days=${days}`).then((r) => r.json()),
		staleTime: 30_000,
		placeholderData: keepPreviousData,
	});
}
