import { useQuery } from "@tanstack/react-query";

import type { ListingRecordResponse } from "#/types/listing";

/**
 * The listing exactly as stored, cached by id and only fetched when a row
 * opens: the table feed carries the rendered columns, not the description, the
 * raw `features` blob or the score/facts rows.
 */
export function useListingRecord(id: number, enabled = true) {
	return useQuery<ListingRecordResponse>({
		queryKey: ["listing-record", id],
		queryFn: () =>
			fetch(`/api/listings?view=record&id=${id}`).then((r) => r.json()),
		enabled,
		staleTime: 60_000,
	});
}
