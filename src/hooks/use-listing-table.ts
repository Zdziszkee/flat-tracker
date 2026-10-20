import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { ListingFilters } from "#/lib/listing-features";
import type { ListingsTableResponse } from "#/types/listing";

export const LISTINGS_PAGE_SIZE = 100;

/**
 * Paginated table feed. The map keeps `/api/listings?view=map`; the table
 * only requests the columns it renders, so opening `/listings` no longer
 * downloads every feature payload on the map.
 */
export function useListingTable(
	filters: ListingFilters,
	page: number,
	pageSize = LISTINGS_PAGE_SIZE,
) {
	const params = new URLSearchParams({
		view: "table",
		page: String(page),
		pageSize: String(pageSize),
	});
	if (filters.source !== "all") params.set("source", filters.source);
	if (filters.days !== 0) params.set("days", String(filters.days));
	if (filters.kind !== "all") params.set("kind", filters.kind);
	if (filters.offerType !== "all") params.set("offerType", filters.offerType);

	return useQuery<ListingsTableResponse>({
		queryKey: ["listings", "table", filters, page, pageSize],
		queryFn: () =>
			fetch(`/api/listings?${params.toString()}`).then((r) => r.json()),
		placeholderData: keepPreviousData,
		staleTime: 30_000,
	});
}
