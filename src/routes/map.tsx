import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import { ListingFilters } from "#/components/listing-filters";
import { useListingFacets } from "#/hooks/use-listing-facets";
import { useListingFilters } from "#/hooks/use-listing-filters";
import { usePublicInvestments } from "#/hooks/use-public-investments";
import { useSources } from "#/hooks/use-sources";
import {
	type ListingFacets,
	listingSearchSchema,
	PUBLIC_INVESTMENTS_KIND,
} from "#/lib/listing-features";
import type { PropertyKind } from "#/lib/property-kind";
import {
	PUBLIC_INVESTMENT_CATEGORY_COLORS,
	PUBLIC_INVESTMENT_CATEGORY_LABELS,
} from "#/lib/public-investments";

// mapbox-gl touches `window` at module load, so it must never be imported
// during SSR. The lazy import is only triggered after mount on the client.
const mapViewImport = () => import("../components/map-view");
const MapView = lazy(mapViewImport);
// Start fetching the mapbox chunk as soon as this route is evaluated on the
// client, instead of waiting for the first post-hydration effect. The chunk is
// by far the largest client dependency, so this removes a visible beat between
// the page shell and the map.
if (typeof window !== "undefined") {
	void mapViewImport();
}

export const Route = createFileRoute("/map")({
	validateSearch: (search) => listingSearchSchema.parse(search),
	component: MapPage,
});

/** localStorage key for the "granice działek" toggle. */
const PARCELS_STORAGE_KEY = "flat-tracker:show-parcels";
/** localStorage key for the "Kolej" overlay toggle. */
const RAILWAYS_STORAGE_KEY = "flat-tracker:show-railways";
const OCCUPANCY_STORAGE_KEY = "flat-tracker:show-occupancy";

function MapPage() {
	const { filters, setFilters } = useListingFilters("/map");
	const { data: facetsData } = useListingFacets(filters.days);
	const { data: sourcesData } = useSources();
	const sources = sourcesData?.sources ?? [];
	const facets: ListingFacets = {
		total: facetsData?.total ?? 0,
		bySource: new Map(Object.entries(facetsData?.bySource ?? {})),
		byKind: new Map(
			Object.entries(facetsData?.byKind ?? {}).map(
				([kind, count]) => [kind as PropertyKind, count] as const,
			),
		),
	};
	const showingPublicInvestments = filters.kind === PUBLIC_INVESTMENTS_KIND;
	const { data: publicInvestments } = usePublicInvestments(
		showingPublicInvestments,
	);
	const publicInvestmentsCount = publicInvestments?.features.length;

	const [mounted, setMounted] = useState(false);
	/**
	 * Cadastral parcel grid. Off the bat it is part of the map look (on), the
	 * toggle mirrors the user's last choice, and the layer itself only draws
	 * from zoom 14 (below that a viewport holds tens of thousands of parcels
	 * and the API cannot return them all).
	 */
	const [showParcels, setShowParcels] = useState(true);
	// Torowiska i stacje kolejowe (wygenerowany overlay OSM).
	const [showRailways, setShowRailways] = useState(true);
	/** Short-term rental occupancy heatmap layer. */
	const [showOccupancy, setShowOccupancy] = useState(false);
	/**
	 * Planned/completed city projects are their own kind in the "Rodzaj"
	 * dropdown; the layer is drawn only while that kind is selected, so it
	 * never clutters the offer categories and is hidden by default.
	 */
	const [occupancySource, setOccupancySource] = useState<
		"airbnb" | "booking" | "all"
	>("all");
	const [occupancyMonth, setOccupancyMonth] = useState(() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	});

	useEffect(() => {
		setMounted(true);
		try {
			const stored = window.localStorage.getItem(PARCELS_STORAGE_KEY);
			if (stored !== null) setShowParcels(stored === "1");
			const railStored = window.localStorage.getItem(RAILWAYS_STORAGE_KEY);
			if (railStored !== null) setShowRailways(railStored === "1");
			const occStored = window.localStorage.getItem(OCCUPANCY_STORAGE_KEY);
			if (occStored !== null) setShowOccupancy(occStored === "1");
		} catch {
			// Private mode / storage disabled: keep the default.
		}
	}, []);

	return (
		<div className="flex h-dvh flex-col">
			<header className="flex flex-wrap items-end justify-between gap-3 border-b px-4 py-2">
				<div>
					<h1 className="text-lg font-semibold">
						Mapa ofert · Małopolska i Śląsk
					</h1>
					<p className="text-xs text-muted-foreground">
						{showingPublicInvestments
							? `${(publicInvestmentsCount ?? 0).toLocaleString("pl-PL")} inwestycji publicznych`
							: `${facets.total.toLocaleString("pl-PL")} ofert w aktywnym oknie`}
					</p>
				</div>
				<ListingFilters
					value={filters}
					sources={sources}
					facets={facets}
					publicInvestmentsCount={publicInvestmentsCount}
					showOfferType
					onChange={setFilters}
				/>
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<label className="flex items-center gap-1.5 text-sm text-foreground">
						<input
							type="checkbox"
							checked={showParcels}
							onChange={(e) => {
								setShowParcels(e.target.checked);
								try {
									window.localStorage.setItem(
										PARCELS_STORAGE_KEY,
										e.target.checked ? "1" : "0",
									);
								} catch {
									// Not fatal: the toggle just won't persist.
								}
							}}
						/>
						Granice działek
					</label>
					<label className="flex items-center gap-1.5 text-sm text-foreground">
						<input
							type="checkbox"
							checked={showRailways}
							onChange={(e) => {
								setShowRailways(e.target.checked);
								try {
									window.localStorage.setItem(
										RAILWAYS_STORAGE_KEY,
										e.target.checked ? "1" : "0",
									);
								} catch {
									// Not fatal: the toggle just won't persist.
								}
							}}
						/>
						Kolej
					</label>
					<label className="flex items-center gap-1.5 text-sm text-foreground">
						<input
							type="checkbox"
							checked={showOccupancy}
							onChange={(e) => {
								setShowOccupancy(e.target.checked);
								try {
									window.localStorage.setItem(
										OCCUPANCY_STORAGE_KEY,
										e.target.checked ? "1" : "0",
									);
								} catch {
									// Not fatal: the toggle just won't persist.
								}
							}}
						/>
						Obłożenie STR
					</label>
					{showOccupancy && (
						<>
							<select
								value={occupancySource}
								onChange={(e) =>
									setOccupancySource(
										e.target.value as "airbnb" | "booking" | "all",
									)
								}
								className="rounded border px-2 py-1 text-sm"
								aria-label="Źródło obłożenia"
							>
								<option value="all">Airbnb + Booking</option>
								<option value="airbnb">Airbnb</option>
								<option value="booking">Booking</option>
							</select>
							<input
								type="month"
								value={occupancyMonth}
								onChange={(e) => setOccupancyMonth(e.target.value)}
								className="rounded border px-2 py-1 text-sm"
								aria-label="Miesiąc obłożenia"
							/>
						</>
					)}
					<Link to="/analytics" className="text-sm text-blue-600 underline">
						Analityka inwestycyjna
					</Link>
					<Link to="/sources" className="text-sm text-blue-600 underline">
						Data sources
					</Link>
				</div>
			</header>

			<div className="relative flex-1">
				{!mounted ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Ładowanie mapy...
					</div>
				) : (
					<Suspense
						fallback={
							<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
								Ładowanie mapy...
							</div>
						}
					>
						<MapView
							source={filters.source}
							days={filters.days}
							offerType={filters.offerType}
							kind={filters.kind}
							showParcels={showParcels}
							showRailways={showRailways}
							showOccupancy={showOccupancy}
							showInvestments={showingPublicInvestments}
							occupancySource={occupancySource}
							occupancyMonth={occupancyMonth}
						/>
					</Suspense>
				)}
			</div>
			{showingPublicInvestments && (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-1.5 text-xs text-gray-600">
					<span className="font-medium text-gray-700">Inwestycje:</span>
					{Object.entries(PUBLIC_INVESTMENT_CATEGORY_LABELS).map(
						([key, label]) => (
							<span key={key} className="inline-flex items-center gap-1.5">
								<span
									className="inline-block size-2 rounded-full"
									style={{
										background:
											PUBLIC_INVESTMENT_CATEGORY_COLORS[
												key as keyof typeof PUBLIC_INVESTMENT_CATEGORY_COLORS
											],
									}}
								/>
								{label}
							</span>
						),
					)}
				</div>
			)}
		</div>
	);
}
