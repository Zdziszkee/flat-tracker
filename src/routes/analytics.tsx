import { barY, defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";

interface InvestmentAnalytics {
	salesByDistrict: Array<{
		district: string;
		avgPriceM2: number | null;
		count: number;
	}>;
	yieldByDistrict: Array<{
		district: string;
		yieldPct: number | null;
		saleAvgM2: number;
		rentAvgM2: number;
		saleCount: number;
		rentCount: number;
	}>;
	monthlyTrend: Array<{
		month: string;
		avgNightly: number | null;
		count: number;
	}>;
	bySource: Array<{ source: string; avgNightly: number | null; count: number }>;
}

function fmt(n: number | null | undefined, digits = 0): string {
	if (n == null) return "";
	return new Intl.NumberFormat("pl-PL", {
		maximumFractionDigits: digits,
	}).format(n);
}

export const Route = createFileRoute("/analytics")({
	component: AnalyticsPage,
});

function AnalyticsPage() {
	const { data, isLoading } = useQuery<InvestmentAnalytics>({
		queryKey: ["investment-analytics"],
		queryFn: () => fetch("/api/investment-analytics").then((r) => r.json()),
	});

	const yieldChart = useMemo(() => {
		const rows = (data?.yieldByDistrict ?? [])
			.filter((r) => r.yieldPct != null)
			.slice(0, 15);
		return defineChart({
			marks: [barY(rows, { x: "district", y: "yieldPct", fill: "#059669" })],
			x: {
				scale: () => scaleBand<string>().padding(0.2),
				axis: { label: "Dzielnica" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "Rentowność %" },
			},
		});
	}, [data]);

	const saleChart = useMemo(() => {
		const rows = (data?.salesByDistrict ?? [])
			.filter((r) => r.avgPriceM2 != null)
			.slice(0, 12);
		return defineChart({
			marks: [barY(rows, { x: "district", y: "avgPriceM2", fill: "#2563eb" })],
			x: {
				scale: () => scaleBand<string>().padding(0.2),
				axis: { label: "Dzielnica" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "zł/m²" },
			},
		});
	}, [data]);

	const sourceChart = useMemo(() => {
		const rows = (data?.bySource ?? []).filter((r) => r.avgNightly != null);
		return defineChart({
			marks: [barY(rows, { x: "source", y: "avgNightly", fill: "#10b981" })],
			x: {
				scale: () => scaleBand<string>().padding(0.2),
				axis: { label: "Źródło" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "zł" },
			},
		});
	}, [data]);

	const trendChart = useMemo(() => {
		const rows = (data?.monthlyTrend ?? []).filter((r) => r.avgNightly != null);
		return defineChart({
			marks: [
				lineY(rows, {
					x: "month",
					y: "avgNightly",
					stroke: "#f59e0b",
					strokeWidth: 2,
					points: true,
				}),
			],
			x: {
				scale: () => scaleBand<string>().padding(0.2),
				axis: { label: "Miesiąc" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "śr. zł/noc" },
			},
		});
	}, [data]);

	if (isLoading) {
		return <div className="p-6 text-sm text-gray-500">Ładowanie...</div>;
	}

	return (
		<div className="p-6">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">
					Analityka inwestycyjna · Małopolska
				</h1>
				<div className="flex items-center gap-3 text-sm">
					<Link to="/map" className="text-blue-600 underline">
						Mapa
					</Link>
				</div>
			</div>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Rentowność najmu długoterminowego wg dzielnicy
					</h2>
					<div className="h-80">
						<Chart
							definition={yieldChart}
							height={300}
							ariaLabel="Rentowność wg dzielnicy"
						/>
					</div>
				</div>
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Cena sprzedaży zł/m² wg dzielnicy
					</h2>
					<div className="h-80">
						<Chart
							definition={saleChart}
							height={300}
							ariaLabel="Cena sprzedaży wg dzielnicy"
						/>
					</div>
				</div>
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Średnia cena najmu wg źródła
					</h2>
					<div className="h-72">
						<Chart
							definition={sourceChart}
							height={280}
							ariaLabel="Cena najmu wg źródła"
						/>
					</div>
				</div>
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Trend cen najmu krótkoterminowego
					</h2>
					<div className="h-72">
						<Chart
							definition={trendChart}
							height={280}
							ariaLabel="Trend cen najmu"
						/>
					</div>
				</div>
			</div>

			<div className="mt-4 overflow-x-auto rounded border">
				<table className="w-full text-sm">
					<thead className="bg-gray-50 text-left">
						<tr>
							<th className="px-3 py-2">Dzielnica</th>
							<th className="px-3 py-2 text-right">Rentowność</th>
							<th className="px-3 py-2 text-right">Cena sprzedaży zł/m²</th>
							<th className="px-3 py-2 text-right">Czynsz zł/m²</th>
							<th className="px-3 py-2 text-right">Oferty sprzedaży</th>
							<th className="px-3 py-2 text-right">Oferty najmu</th>
						</tr>
					</thead>
					<tbody>
						{(data?.yieldByDistrict ?? []).map((r) => (
							<tr key={r.district} className="border-t hover:bg-gray-50">
								<td className="px-3 py-1.5">{r.district}</td>
								<td className="px-3 py-1.5 text-right font-medium">
									{fmt(r.yieldPct, 1)}%
								</td>
								<td className="px-3 py-1.5 text-right">{fmt(r.saleAvgM2)}</td>
								<td className="px-3 py-1.5 text-right">{fmt(r.rentAvgM2)}</td>
								<td className="px-3 py-1.5 text-right">{r.saleCount}</td>
								<td className="px-3 py-1.5 text-right">{r.rentCount}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
