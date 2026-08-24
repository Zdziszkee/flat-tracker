import { barY, defineChart, lineY } from "@tanstack/charts";
import { geoShape } from "@tanstack/charts/geo";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { geoMercator } from "d3-geo";
import { useMemo, useState } from "react";

import { malopolskaPowiats } from "#/data/malopolska-powiats";

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

interface ValuationRow {
	district: string;
	saleAvgM2: number;
	rentAvgM2: number;
	grossYieldPct: number;
	fairPriceM2: number;
	overUnderPct: number;
	paybackYears: number;
	priceToRent: number;
	tenYearReturnPct: number;
	valueScore: number;
	saleCount: number;
	rentCount: number;
}

interface MarketInsights {
	summary: {
		saleCount: number;
		saleAvgM2: number | null;
		rentCount: number;
		rentAvgM2: number | null;
		rcnTxCount: number;
		rcnAvgM2: number | null;
		gapPct: number | null;
	};
	priceByRooms: Array<{
		label: string;
		avgM2: number | null;
		avgPrice: number | null;
		count: number;
	}>;
	priceHistogram: Array<{ label: string; count: number }>;
	priceDrops: { droppedCount: number; avgDropPct: number | null };
	occupancyByMonth: Array<{ month: string; occupancyPct: number }>;
	rcnByMarket: Array<{ market: string; avgM2: number | null; count: number }>;
	rcnYearly: Array<{ year: number; avgM2: number | null; count: number }>;
}

function fmt(n: number | null | undefined, digits = 0): string {
	if (n == null) return "";
	return new Intl.NumberFormat("pl-PL", {
		maximumFractionDigits: digits,
	}).format(n);
}

type DistrictMetricKey =
	| "saleAvgM2"
	| "saleCount"
	| "rentAvgM2"
	| "yieldPct"
	| "rcnAvgM2";

interface DistrictMetric {
	name: string;
	saleCount: number;
	saleAvgM2: number | null;
	rentCount: number;
	rentAvgM2: number | null;
	yieldPct: number | null;
	rcnCount: number;
	rcnAvgM2: number | null;
}

const DISTRICT_METRICS: Array<{
	key: DistrictMetricKey;
	label: string;
	unit: string;
}> = [
	{ key: "saleAvgM2", label: "Cena sprzedaży", unit: "zł/m²" },
	{ key: "saleCount", label: "Oferty sprzedaży", unit: "szt." },
	{ key: "rentAvgM2", label: "Czynsz", unit: "zł/m²" },
	{ key: "yieldPct", label: "Rentowność", unit: "%" },
	{ key: "rcnAvgM2", label: "Transakcje RCN", unit: "zł/m²" },
];

/** Sequential light-blue -> dark-blue ramp for choropleth fills. */
function seqColor(t: number): string {
	const c = Math.max(0, Math.min(1, t));
	const r = Math.round(224 + (30 - 224) * c);
	const g = Math.round(242 + (58 - 242) * c);
	const b = Math.round(254 + (138 - 254) * c);
	return `rgb(${r},${g},${b})`;
}

export const Route = createFileRoute("/analytics")({
	component: AnalyticsPage,
});

function AnalyticsPage() {
	const { data, isLoading } = useQuery<InvestmentAnalytics>({
		queryKey: ["investment-analytics"],
		queryFn: () => fetch("/api/investment-analytics").then((r) => r.json()),
	});
	const { data: valuation } = useQuery<{ rows: ValuationRow[] }>({
		queryKey: ["valuation"],
		queryFn: () => fetch("/api/valuation").then((r) => r.json()),
	});
	const { data: insights } = useQuery<MarketInsights>({
		queryKey: ["market-insights"],
		queryFn: () => fetch("/api/market-insights").then((r) => r.json()),
	});
	const { data: districtMap } = useQuery<{ features: DistrictMetric[] }>({
		queryKey: ["powiat-map"],
		queryFn: () => fetch("/api/powiat-map").then((r) => r.json()),
	});
	const [metric, setMetric] = useState<DistrictMetricKey>("saleAvgM2");

	const choropleth = useMemo(() => {
		const byName = new Map(
			(districtMap?.features ?? []).map((f) => [f.name, f]),
		);
		const features = malopolskaPowiats.map((f) => {
			const m = byName.get(f.properties.name);
			return {
				type: "Feature" as const,
				properties: {
					name: f.properties.name,
					saleCount: m?.saleCount ?? 0,
					saleAvgM2: m?.saleAvgM2 ?? null,
					rentCount: m?.rentCount ?? 0,
					rentAvgM2: m?.rentAvgM2 ?? null,
					yieldPct: m?.yieldPct ?? null,
					rcnAvgM2: m?.rcnAvgM2 ?? null,
				},
				geometry: f.geometry,
			};
		});
		const values = features.flatMap((f) => {
			const v = f.properties[metric];
			return typeof v === "number" && Number.isFinite(v) ? [v] : [];
		});
		const min = values.length ? Math.min(...values) : 0;
		const max = values.length ? Math.max(...values) : 1;
		const span = max - min || 1;
		return {
			definition: defineChart({
				marks: [
					geoShape(features, {
						key: (f) => f.properties.name,
						projection: { type: () => geoMercator(), fit: "data" },
						fill: (f) => {
							const v = f.properties[metric];
							return typeof v === "number" && Number.isFinite(v)
								? seqColor((v - min) / span)
								: "#e5e7eb";
						},
						stroke: "#ffffff",
						strokeWidth: 0.5,
					}),
				],
				margin: 8,
			}),
			min,
			max,
		};
	}, [districtMap, metric]);

	const rcnMarketChart = useMemo(() => {
		const rows = (insights?.rcnByMarket ?? []).filter((r) => r.avgM2 != null);
		return defineChart({
			marks: [barY(rows, { x: "market", y: "avgM2", fill: "#7c3aed" })],
			x: {
				scale: () => scaleBand<string>().padding(0.3),
				axis: { label: "Rynek" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "zł/m² transakcyjna" },
			},
		});
	}, [insights]);

	const rcnYearlyChart = useMemo(() => {
		const rows = (insights?.rcnYearly ?? [])
			.filter((r) => r.avgM2 != null)
			.map((r) => ({ ...r, year: String(r.year) }));
		return defineChart({
			marks: [
				lineY(rows, {
					x: "year",
					y: "avgM2",
					stroke: "#7c3aed",
					strokeWidth: 2,
					points: true,
				}),
			],
			x: {
				scale: () => scaleBand<string>().padding(0.2),
				axis: { label: "Rok" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "zł/m² transakcyjna" },
			},
		});
	}, [insights]);

	const roomsChart = useMemo(() => {
		const rows = (insights?.priceByRooms ?? []).filter((r) => r.avgM2 != null);
		return defineChart({
			marks: [barY(rows, { x: "label", y: "avgM2", fill: "#0891b2" })],
			x: {
				scale: () => scaleBand<string>().padding(0.2),
				axis: { label: "Liczba pokoi" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "zł/m²" },
			},
		});
	}, [insights]);

	const histChart = useMemo(() => {
		const rows = insights?.priceHistogram ?? [];
		return defineChart({
			marks: [barY(rows, { x: "label", y: "count", fill: "#f97316" })],
			x: {
				scale: () => scaleBand<string>().padding(0.1),
				axis: { label: "Cena zł/m²" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "Liczba ofert" },
			},
		});
	}, [insights]);

	const occupancyChart = useMemo(() => {
		const rows = insights?.occupancyByMonth ?? [];
		return defineChart({
			marks: [barY(rows, { x: "month", y: "occupancyPct", fill: "#14b8a6" })],
			x: {
				scale: () => scaleBand<string>().padding(0.2),
				axis: { label: "Miesiąc" },
			},
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "Obłożenie %" },
			},
		});
	}, [insights]);

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
					<Link to="/sources" className="text-blue-600 underline">
						Data sources
					</Link>
				</div>
			</div>

			<div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
				<div className="rounded border p-2 lg:col-span-2">
					<div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1">
						<h2 className="text-sm font-semibold text-gray-600">
							Małopolska — powiaty (heatmapa)
						</h2>
						<div className="flex flex-wrap gap-1">
							{DISTRICT_METRICS.map((m) => (
								<button
									key={m.key}
									type="button"
									onClick={() => setMetric(m.key)}
									className={`rounded px-2 py-1 text-xs ${
										metric === m.key
											? "bg-blue-600 text-white"
											: "bg-gray-100 text-gray-600 hover:bg-gray-200"
									}`}
								>
									{m.label}
								</button>
							))}
						</div>
					</div>
					<div className="h-96">
						<Chart
							definition={choropleth.definition}
							height={380}
							ariaLabel="Mapa powiatów Małopolski"
						/>
					</div>
					<div className="flex items-center gap-2 px-2 pt-1 text-xs text-gray-500">
						<span>
							{fmt(choropleth.min)}{" "}
							{DISTRICT_METRICS.find((m) => m.key === metric)?.unit}
						</span>
						<div
							className="h-2 flex-1 rounded"
							style={{
								background:
									"linear-gradient(to right, rgb(224,242,254), rgb(30,58,138))",
							}}
						/>
						<span>
							{fmt(choropleth.max)}{" "}
							{DISTRICT_METRICS.find((m) => m.key === metric)?.unit}
						</span>
					</div>
				</div>
				<div className="overflow-x-auto rounded border">
					<h2 className="px-3 py-2 text-sm font-semibold text-gray-600">
						Powiaty wg: {DISTRICT_METRICS.find((m) => m.key === metric)?.label}
					</h2>
					<table className="w-full text-sm">
						<thead className="bg-gray-50 text-left">
							<tr>
								<th className="px-3 py-1.5">Dzielnica</th>
								<th className="px-3 py-1.5 text-right">Wartość</th>
							</tr>
						</thead>
						<tbody>
							{[...(districtMap?.features ?? [])]
								.map((f) => ({
									name: f.name,
									value: f[metric] as number | null,
								}))
								.sort(
									(a, b) =>
										(b.value ?? Number.NEGATIVE_INFINITY) -
										(a.value ?? Number.NEGATIVE_INFINITY),
								)
								.map((r) => (
									<tr key={r.name} className="border-t hover:bg-gray-50">
										<td className="px-3 py-1">{r.name}</td>
										<td className="px-3 py-1 text-right">
											{fmt(r.value, metric === "saleCount" ? 0 : 1)}
										</td>
									</tr>
								))}
						</tbody>
					</table>
				</div>
			</div>

			<div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
				{[
					{
						label: "Oferty sprzedaży",
						value: `${fmt(insights?.summary.saleCount)}`,
						sub: `${fmt(insights?.summary.saleAvgM2)} zł/m²`,
					},
					{
						label: "Najem długoterm.",
						value: `${fmt(insights?.summary.rentCount)}`,
						sub: `${fmt(insights?.summary.rentAvgM2)} zł/m²`,
					},
					{
						label: "Transakcje RCN (2 lata)",
						value: `${fmt(insights?.summary.rcnTxCount)}`,
						sub: `${fmt(insights?.summary.rcnAvgM2)} zł/m²`,
					},
					{
						label: "Oferta vs transakcja",
						value: `${fmt(insights?.summary.gapPct, 1)}%`,
						sub: "przewartościowanie",
					},
					{
						label: "Obniżki cen",
						value: `${fmt(insights?.priceDrops.droppedCount)}`,
						sub:
							insights?.priceDrops.avgDropPct != null
								? `śr. -${fmt(insights.priceDrops.avgDropPct, 1)}%`
								: "brak danych",
					},
				].map((m) => (
					<div key={m.label} className="rounded border bg-gray-50 p-3">
						<div className="text-xs text-gray-500">{m.label}</div>
						<div className="mt-1 text-lg font-semibold">{m.value}</div>
						<div className="text-xs text-gray-500">{m.sub}</div>
					</div>
				))}
			</div>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Rynek transakcyjny RCN · pierwotny vs wtórny
					</h2>
					<div className="h-64">
						<Chart
							definition={rcnMarketChart}
							height={250}
							ariaLabel="RCN pierwotny vs wtórny"
						/>
					</div>
				</div>
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Trend cen transakcyjnych zł/m² (RCN)
					</h2>
					<div className="h-64">
						<Chart
							definition={rcnYearlyChart}
							height={250}
							ariaLabel="Trend cen transakcyjnych"
						/>
					</div>
				</div>
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Cena ofertowa zł/m² wg liczby pokoi
					</h2>
					<div className="h-64">
						<Chart
							definition={roomsChart}
							height={250}
							ariaLabel="Cena wg pokoi"
						/>
					</div>
				</div>
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Rozkład cen ofertowych zł/m²
					</h2>
					<div className="h-64">
						<Chart
							definition={histChart}
							height={250}
							ariaLabel="Rozkład cen zł/m²"
						/>
					</div>
				</div>
				<div className="rounded border p-2">
					<h2 className="px-2 py-1 text-sm font-semibold text-gray-600">
						Obłożenie najmu krótkoterminowego wg miesiąca
					</h2>
					<div className="h-64">
						<Chart
							definition={occupancyChart}
							height={250}
							ariaLabel="Obłożenie wg dzielnicy"
						/>
					</div>
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
				<h2 className="px-3 py-2 text-sm font-semibold text-gray-600">
					Top 15 okazje — przewartościowane vs niedowartościowane
				</h2>
				<table className="w-full text-sm">
					<thead className="bg-gray-50 text-left">
						<tr>
							<th className="px-3 py-2">Dzielnica</th>
							<th className="px-3 py-2 text-right">Wynik</th>
							<th className="px-3 py-2 text-right">Cena zł/m²</th>
							<th className="px-3 py-2 text-right">Czynsz zł/m²</th>
							<th className="px-3 py-2 text-right">Rentowność</th>
							<th className="px-3 py-2 text-right">Wartość godziwa</th>
							<th className="px-3 py-2 text-right">Przewart.</th>
							<th className="px-3 py-2 text-right">Zwrot (lata)</th>
							<th className="px-3 py-2 text-right">Zwrot 10 lat</th>
						</tr>
					</thead>
					<tbody>
						{(valuation?.rows ?? []).map((r) => (
							<tr key={r.district} className="border-t hover:bg-gray-50">
								<td className="px-3 py-1.5">{r.district}</td>
								<td className="px-3 py-1.5 text-right font-medium">
									{fmt(r.valueScore, 1)}
								</td>
								<td className="px-3 py-1.5 text-right">{fmt(r.saleAvgM2)}</td>
								<td className="px-3 py-1.5 text-right">
									{fmt(r.rentAvgM2, 1)}
								</td>
								<td className="px-3 py-1.5 text-right">
									{fmt(r.grossYieldPct, 1)}%
								</td>
								<td className="px-3 py-1.5 text-right">{fmt(r.fairPriceM2)}</td>
								<td className="px-3 py-1.5 text-right">
									{fmt(r.overUnderPct, 1)}%
								</td>
								<td className="px-3 py-1.5 text-right">
									{fmt(r.paybackYears, 1)}
								</td>
								<td className="px-3 py-1.5 text-right">
									{fmt(r.tenYearReturnPct, 1)}%
								</td>
							</tr>
						))}
					</tbody>
				</table>
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
