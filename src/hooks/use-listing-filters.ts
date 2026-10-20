import { useNavigate, useSearch } from "@tanstack/react-router";

import {
	filtersFromSearch,
	type ListingFilters,
	type ListingSearch,
	searchFromFilters,
} from "#/lib/listing-features";

/**
 * URL-backed filter state shared by `/map` and `/listings`. The route defines
 * `validateSearch: listingSearchSchema.parse`, so this hook only converts
 * between the search object and the domain filter shape.
 */
export function useListingFilters(from: "/map" | "/listings") {
	const search = useSearch({ from }) as ListingSearch;
	const navigate = useNavigate({ from });

	const filters = filtersFromSearch(search);
	const setFilters = (next: ListingFilters) => {
		void navigate({
			search: searchFromFilters(next),
			replace: true,
		});
	};

	return { filters, setFilters };
}
