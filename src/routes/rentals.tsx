import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

interface RentalStatRow {
	listingId: number;
	month: string;
	avgListedPrice: number | null;
	avgEffectiveNightlyPrice: number | null;
	minPrice: number | null;
	maxPrice: number | null;
	sampleDays: number | null;
	bookedNights: number | null;
	title: string;
	source: string;
	district: string | null;
	offerType: string;
	pricePeriod: string | null;
	lat: number | null;
	lng: number | null;
}

interface RentalAnalyticsRow {
	listingId: number;
	title: string;
	source: string;
	district: string | null;
	sampleDays: number;
	bookedNights: number;
	avgListed: number | null;
	avgEffective: number | null;
	revenue: number | null;
	occupancy: number;
	priceGap: number | null;
}

function fmt(n: number | null | undefined): string {
	if (n == null) return "";
	return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(n);
}

const SOURCE_LABELS: Record<string, string> = {
	airbnb: "Airbnb",
	booking: "Booking",
	"olx-rent": "OLX wynajem",
};

export const Route = createFileRoute("/rentals")({
	component: RentalsPage,
});

function RentalsPage() {
	const [source, setSource] = useState("all");
	const { data, isLoading } = useQuery<{ rows: RentalStatRow[] }>({
		queryKey: ["rental-stats"],
		queryFn: () => fetch("/api/rental-stats").then((r) => r.json()),
	});
	const { data: analytics } = useQuery<{ rows: RentalAnalyticsRow[] }>({
		queryKey: ["rental-analytics"],
		queryFn: () => fetch("/api/rental-analytics").then((r) => r.json()),
	});

	const rows = (data?.rows ?? []).filter(
		(r) => source === "all" || r.source === source,
	);
	const summaryRows = (analytics?.rows ?? []).filter(
		(r) => source === "all" || r.source === source,
	);

	return (
		<div className="p-6">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">Statystyki najmu · Małopolska</h1>
				<div className="flex items-center gap-3 text-sm">
					<select
						value={source}
						onChange={(e) => setSource(e.target.value)}
						className="rounded border px-2 py-1"
					>
						<option value="all">Wszystkie</option>
						<option value="airbnb">Airbnb</option>
						<option value="booking">Booking</option>
						<option value="olx-rent">OLX wynajem</option>
					</select>
					<Link to="/map" className="text-blue-600 underline">
						Mapa
					</Link>
				</div>
			</div>

			<div className="mb-4 overflow-x-auto rounded border">
				<h2 className="px-3 py-2 text-sm font-semibold text-gray-600">
					Podsumowanie obłożenia i przychodu
				</h2>
				<table className="w-full text-sm">
					<thead className="bg-gray-50 text-left">
						<tr>
							<th className="px-3 py-2">Tytuł</th>
							<th className="px-3 py-2 text-right">Obłożenie</th>
							<th className="px-3 py-2 text-right">Śr. noc</th>
							<th className="px-3 py-2 text-right">Różnica ceny</th>
							<th className="px-3 py-2 text-right">Szac. przychód</th>
						</tr>
					</thead>
					<tbody>
						{summaryRows.map((r) => (
							<tr key={r.listingId} className="border-t hover:bg-gray-50">
								<td className="max-w-96 truncate px-3 py-1.5">{r.title}</td>
								<td className="px-3 py-1.5 text-right">{r.occupancy}%</td>
								<td className="px-3 py-1.5 text-right">
									{fmt(r.avgEffective)} zł
								</td>
								<td className="px-3 py-1.5 text-right">
									{r.priceGap == null ? "" : `${fmt(r.priceGap)} zł`}
								</td>
								<td className="px-3 py-1.5 text-right">{fmt(r.revenue)} zł</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div className="overflow-x-auto rounded border">
				<table className="w-full text-sm">
					<thead className="bg-gray-50 text-left">
						<tr>
							<th className="px-3 py-2">Źródło</th>
							<th className="px-3 py-2">Tytuł</th>
							<th className="px-3 py-2">Dzielnica</th>
							<th className="px-3 py-2">Miesiąc</th>
							<th className="px-3 py-2 text-right">Śr. cena/noc</th>
							<th className="px-3 py-2 text-right">Min</th>
							<th className="px-3 py-2 text-right">Max</th>
							<th className="px-3 py-2 text-right">Noce zajęte</th>
						</tr>
					</thead>
					<tbody>
						{isLoading && (
							<tr>
								<td colSpan={8} className="px-3 py-6 text-center text-gray-500">
									Ładowanie...
								</td>
							</tr>
						)}
						{!isLoading &&
							rows.map((r) => (
								<tr
									key={`${r.listingId}-${r.month}`}
									className="border-t hover:bg-gray-50"
								>
									<td className="px-3 py-1.5">
										{SOURCE_LABELS[r.source] ?? r.source}
									</td>
									<td className="max-w-96 truncate px-3 py-1.5">{r.title}</td>
									<td className="px-3 py-1.5">{r.district ?? ""}</td>
									<td className="px-3 py-1.5">{r.month}</td>
									<td className="px-3 py-1.5 text-right font-medium">
										{r.pricePeriod === "night"
											? `${fmt(r.avgEffectiveNightlyPrice)} zł`
											: `${fmt(r.avgEffectiveNightlyPrice)} zł/mies.`}
									</td>
									<td className="px-3 py-1.5 text-right">{fmt(r.minPrice)}</td>
									<td className="px-3 py-1.5 text-right">{fmt(r.maxPrice)}</td>
									<td className="px-3 py-1.5 text-right">
										{r.bookedNights ?? ""}
									</td>
								</tr>
							))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
