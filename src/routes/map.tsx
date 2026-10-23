import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

import { ListingFilters } from "#/components/listing-filters";
import { useListingFilters } from "#/hooks/use-listing-filters";
import { useListings } from "#/hooks/use-listings";
import { useSources } from "#/hooks/use-sources";
import { listingFacets, listingSearchSchema } from "#/lib/listing-features";
import {
	PUBLIC_INVESTMENT_CATEGORY_COLORS,
	PUBLIC_INVESTMENT_CATEGORY_LABELS,
} from "#/lib/public-investments";

// mapbox-gl touches `window` at module load, so it must never be imported
// during SSR. The lazy import is only triggered after mount on the client.
const MapView = lazy(() => import("../components/map-view"));

export const Route = createFileRoute("/map")({
	validateSearch: (search) => listingSearchSchema.parse(search),
	component: MapPage,
});

/** localStorage key for the "granice działek" toggle. */
const PARCELS_STORAGE_KEY = "flat-tracker:show-parcels";
/** localStorage key for the "Kolej" overlay toggle. */
const RAILWAYS_STORAGE_KEY = "flat-tracker:show-railways";
const OCCUPANCY_STORAGE_KEY = "flat-tracker:show-occupancy";
const PUBLIC_INVESTMENTS_STORAGE_KEY = "flat-tracker:show-public-investments";

function MapPage() {
	const { filters, setFilters } = useListingFilters("/map");
	const { data } = useListings();
	const { data: sourcesData } = useSources();
	const sources = sourcesData?.sources ?? [];
	const facets = listingFacets(data?.listings ?? [], filters.days);

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
	/** Planned/completed city projects (roads, schools, parks, ...). */
	const [showInvestments, setShowInvestments] = useState(false);
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
			const investmentsStored = window.localStorage.getItem(
				PUBLIC_INVESTMENTS_STORAGE_KEY,
			);
			if (investmentsStored !== null) {
				setShowInvestments(investmentsStored === "1");
			}
		} catch {
			// Private mode / storage disabled: keep the default.
		}
	}, []);

	return (
		<div className="flex h-[calc(100vh-4rem)] flex-col">
			<header className="flex flex-wrap items-end justify-between gap-3 border-b px-4 py-2">
				<div>
					<h1 className="text-lg font-semibold">
						Mapa ofert · Małopolska i Śląsk
					</h1>
					<p className="text-xs text-gray-500">
						{facets.total.toLocaleString("pl-PL")} ofert w aktywnym oknie
					</p>
				</div>
				<ListingFilters
					value={filters}
					sources={sources}
					facets={facets}
					showOfferType
					onChange={setFilters}
				/>
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<label className="flex items-center gap-1.5 text-sm text-gray-700">
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
					<label className="flex items-center gap-1.5 text-sm text-gray-700">
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
					<label className="flex items-center gap-1.5 text-sm text-gray-700">
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
					<label className="flex items-center gap-1.5 text-sm text-gray-700">
						<input
							type="checkbox"
							checked={showInvestments}
							onChange={(e) => {
								setShowInvestments(e.target.checked);
								try {
									window.localStorage.setItem(
										PUBLIC_INVESTMENTS_STORAGE_KEY,
										e.target.checked ? "1" : "0",
									);
								} catch {
									// Not fatal: the toggle just won't persist.
								}
							}}
						/>
						Inwestycje publiczne
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
					<div className="flex h-full items-center justify-center text-sm text-gray-500">
						Ładowanie mapy...
					</div>
				) : (
					<Suspense
						fallback={
							<div className="flex h-full items-center justify-center text-sm text-gray-500">
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
							showInvestments={showInvestments}
							occupancySource={occupancySource}
							occupancyMonth={occupancyMonth}
						/>
					</Suspense>
				)}
			</div>
			{showInvestments && (
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
