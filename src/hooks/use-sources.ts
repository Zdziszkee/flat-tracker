import { useQuery } from "@tanstack/react-query";

/** Source list for the filter bar; shared so both screens use one cache. */
export function useSources() {
	return useQuery<{ sources: string[] }>({
		queryKey: ["sources"],
		queryFn: () => fetch("/api/sources").then((r) => r.json()),
		staleTime: 5 * 60_000,
	});
}
