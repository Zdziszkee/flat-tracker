import { useQuery } from "@tanstack/react-query";

import type { OfferValuation } from "#/types/listing";

/** Per-offer valuation, cached by id and only fetched when a row opens. */
export function useValuation(id: number, enabled = true) {
	return useQuery<OfferValuation>({
		queryKey: ["valuation-offer", id],
		queryFn: () => fetch(`/api/valuation/offer?id=${id}`).then((r) => r.json()),
		enabled,
		staleTime: 5 * 60_000,
	});
}
