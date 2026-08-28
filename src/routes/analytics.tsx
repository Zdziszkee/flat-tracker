import { barY, defineChart, dot, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";

/**
 * Analityka rynku — 19 wykresów: najem (histogramy czynszu, opłat i
 * kosztu łącznego), transakcje RCN/GUGiK (trend, wolumen, pokoje,
 * pierwotny vs wtórny), podaż ofert, rentowność LT i najem
 * krótkoterminowy (ceny, obłożenie, sezonowość, dzień tygodnia).
 */

interface HistogramBucket {
	label: string;
	n: number;
}

interface MarketCharts {
	priceTrend: Array<{ month: string; avgM2: number; tx: number }>;
	yoyByPowiat: Array<{
		powiat: string;
		growthPct: number;
		recent: number | null;
		prior: number | null;
		tx: number;
	}>;
	txVolume: Array<{ month: string; tx: number }>;
	primaryVsSecondary: Array<{
		powiat: string;
		wtorny: number;
		pierwotny: number;
	}>;
	offerVsTxGap: Array<{
		month: string;
		askM2: number;
		txM2: number;
		gapPct: number;
	}>;
	grossYieldByCity: Array<{
		city: string;
		saleM2: number;
		rentM2: number;
		yieldPct: number;
		saleCount: number;
		rentCount: number;
	}>;
	strOccupancyByCity: Array<{
		city: string;
		occupancy: number;
		n: number;
	}>;
	strPriceByMonth: Array<{
		month: string;
		source: string;
		avgPrice: number;
	}>;
	occupancyByMonth: Array<{ month: string; occupancy: number }>;
	weekdayPremium: Array<{
		weekday: number;
		avgPrice: number;
		bookedShare: number;
	}>;
	occupancyVsYield: Array<{
		city: string;
		yieldPct: number;
		occupancy: number;
	}>;
	areaSegments: Array<{ label: string; avgM2: number; n: number }>;
	newSupply: Array<{ month: string; segment: string; n: number }>;
	nightlyByCity: Array<{
		city: string;
		source: string;
		avgNightly: number;
		n: number;
	}>;
	priceDropsByCity: Array<{
		city: string;
		dropped: number;
		total: number;
		dropPct: number;
	}>;
	rentHistogram: HistogramBucket[];
	rentMeta: { avg: number; median: number };
	oplatyHistogram: HistogramBucket[];
	oplatyMeta: { avg: number; median: number };
	totalHistogram: HistogramBucket[];
	totalMeta: { avg: number; median: number };
	txByRooms: Array<{ label: string; avgM2: number; n: number }>;
}

interface ValuationRow {
	district: string;
	saleAvgM2: number;
	rentAvgM2: number;
	grossYieldPct: number;
	fairPriceM2: number;
	overUnderPct: number;
	paybackYears: number;
	valueScore: number;
}

const DOW = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];

function bandX(label: string) {
	return {
		scale: () => scaleBand<string>().padding(0.25),
		axis: { label },
	};
}
function linY(label: string) {
	return {
		scale: scaleLinear,
		nice: true,
		grid: true,
		axis: { label },
	};
}

export const Route = createFileRoute("/analytics")({
	component: AnalyticsPage,
});

function AnalyticsPage() {
	const { data, isLoading, error } = useQuery<MarketCharts>({
		queryKey: ["market-charts"],
		queryFn: () => fetch("/api/market-charts").then((r) => r.json()),
		staleTime: 5 * 60 * 1000,
	});
	const { data: valuation } = useQuery<{ rows: ValuationRow[] }>({
		queryKey: ["valuation"],
		queryFn: () => fetch("/api/valuation").then((r) => r.json()),
	});

	const charts = useMemo<{ [key: string]: unknown }>(() => {
		if (!data) return {};
		const c: { [key: string]: unknown } = {};

		// 1. Liczba ofert wg przedziału czynszu (histogram najmu LT)
		c.rentHistogram = defineChart({
			marks: [
				barY(data.rentHistogram, { x: "label", y: "n", fill: "#2563eb" }),
			],
			x: bandX("Czynsz mies. (zł)"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "liczba ofert" },
			},
		});

		// 2. Liczba ofert wg przedziału opłat (czynsz adm.)
		c.oplatyHistogram = defineChart({
			marks: [
				barY(data.oplatyHistogram, { x: "label", y: "n", fill: "#f59e0b" }),
			],
			x: bandX("Czynsz adm. (zł)"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "liczba ofert" },
			},
		});

		// 3. Liczba ofert wg kosztu łącznego (czynsz + opłaty)
		c.totalHistogram = defineChart({
			marks: [
				barY(data.totalHistogram, { x: "label", y: "n", fill: "#16a34a" }),
			],
			x: bandX("Czynsz + opłaty (zł/mies.)"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "liczba ofert" },
			},
		});

		// 4. Trend cen transakcyjnych
		c.priceTrend = defineChart({
			marks: [
				lineY(data.priceTrend, {
					x: "month",
					y: "avgM2",
					stroke: "#7c3aed",
					strokeWidth: 2,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("zł/m² (transakcje)"),
		});

		// 5. Wolumen transakcji miesięcznie
		c.txVolume = defineChart({
			marks: [barY(data.txVolume, { x: "month", y: "tx", fill: "#2563eb" })],
			x: bandX("Miesiąc"),
			y: linY("liczba transakcji"),
		});

		// 6. Nowe oferty sprzedaż vs najem vs STR miesięcznie
		const supplySale = data.newSupply.filter((r) => r.segment === "sprzedaż");
		const supplyRent = data.newSupply.filter((r) => r.segment === "najem");
		const supplyStr = data.newSupply.filter((r) => r.segment === "STR");
		c.newSupply = defineChart({
			marks: [
				lineY(supplySale, {
					x: "month",
					y: "n",
					stroke: "#2563eb",
					strokeWidth: 2,
				}),
				lineY(supplyRent, {
					x: "month",
					y: "n",
					stroke: "#059669",
					strokeWidth: 2,
				}),
				lineY(supplyStr, {
					x: "month",
					y: "n",
					stroke: "#ff385c",
					strokeWidth: 1.5,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("nowe oferty"),
		});

		// 7. Wzrost cen transakcyjnych r/r wg powiatu
		const yoySorted = [...data.yoyByPowiat].sort(
			(a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0),
		);
		c.yoyByPowiat = defineChart({
			marks: [
				barY(yoySorted, {
					x: "powiat",
					y: "growthPct",
					fill: (d) => ((d.growthPct ?? 0) >= 0 ? "#16a34a" : "#dc2626"),
				}),
			],
			x: bandX("Powiat"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "wzrost % r/r" },
			},
		});

		// 8. Rentowność najmu LT wg miasta
		const yieldSorted = [...data.grossYieldByCity].sort(
			(a, b) => b.yieldPct - a.yieldPct,
		);
		c.grossYield = defineChart({
			marks: [
				barY(yieldSorted, { x: "city", y: "yieldPct", fill: "#059669" }),
			],
			x: bandX("Miasto"),
			y: linY("rentowność brutto %"),
		});

		// 9. Luka oferta vs transakcja
		c.offerVsTxGap = defineChart({
			marks: [
				lineY(data.offerVsTxGap, {
					x: "month",
					y: "askM2",
					stroke: "#2563eb",
					strokeWidth: 2,
				}),
				lineY(data.offerVsTxGap, {
					x: "month",
					y: "txM2",
					stroke: "#7c3aed",
					strokeWidth: 2,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("zł/m²"),
		});

		// 10. Pierwotny vs wtórny wg powiatu
		c.primaryVsSecondary = defineChart({
			marks: [
				barY(data.primaryVsSecondary, {
					x: "powiat",
					y: "wtorny",
					fill: "#64748b",
				}),
				barY(data.primaryVsSecondary, {
					x: "powiat",
					y: "pierwotny",
					fill: "#f97316",
				}),
			],
			x: bandX("Powiat"),
			y: linY("zł/m²"),
		});

		// 11. Cena transakcyjna wg liczby pokoi
		c.txByRooms = defineChart({
			marks: [
				barY(data.txByRooms, { x: "label", y: "avgM2", fill: "#0891b2" }),
			],
			x: bandX("Liczba pokoi"),
			y: linY("zł/m²"),
		});

		// 12. Cena ofertowa zł/m² wg metrażu
		c.areaSegments = defineChart({
			marks: [
				barY(data.areaSegments, { x: "label", y: "avgM2", fill: "#0891b2" }),
			],
			x: bandX("Metraż"),
			y: linY("zł/m²"),
		});

		// 13. STR cena nocna wg miesiąca (Airbnb vs Booking)
		const abMonth = data.strPriceByMonth.filter((r) => r.source === "airbnb");
		const bkMonth = data.strPriceByMonth.filter((r) => r.source === "booking");
		c.strPriceByMonth = defineChart({
			marks: [
				lineY(abMonth, {
					x: "month",
					y: "avgPrice",
					stroke: "#ff385c",
					strokeWidth: 2,
					points: true,
				}),
				lineY(bkMonth, {
					x: "month",
					y: "avgPrice",
					stroke: "#003580",
					strokeWidth: 2,
					points: true,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("śr. zł/noc"),
		});

		// 14. STR obłożenie wg miesiąca
		c.occupancyByMonth = defineChart({
			marks: [
				barY(data.occupancyByMonth, {
					x: "month",
					y: "occupancy",
					fill: "#14b8a6",
				}),
			],
			x: bandX("Miesiąc"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "obłożenie (0-1)" },
			},
		});

		// 15. Premia weekendowa — cena wg dnia tygodnia check-inu
		const dowRows = data.weekdayPremium.map((r) => ({
			...r,
			day: DOW[r.weekday] ?? String(r.weekday),
		}));
		c.weekdayPremium = defineChart({
			marks: [barY(dowRows, { x: "day", y: "avgPrice", fill: "#f59e0b" })],
			x: bandX("Dzień tygodnia (check-in)"),
			y: linY("śr. zł/noc"),
		});

		// 16. STR obłożenie wg miasta
		const occSorted = [...data.strOccupancyByCity].sort(
			(a, b) => (b.occupancy ?? 0) - (a.occupancy ?? 0),
		);
		c.strOccupancy = defineChart({
			marks: [
				barY(occSorted, { x: "city", y: "occupancy", fill: "#0d9488" }),
			],
			x: bandX("Miasto"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "obłożenie (0-1)" },
			},
		});

		// 17. Obłożenie STR vs rentowność LT (scatter)
		const occMap = new Map(
			data.strOccupancyByCity.map((r) => [r.city, r.occupancy]),
		);
		const scatterRows = data.grossYieldByCity
			.filter((r) => occMap.has(r.city))
			.map((r) => ({
				city: r.city,
				yieldPct: r.yieldPct,
				occupancy: (occMap.get(r.city) ?? 0) * 100,
			}));
		c.occupancyVsYield = defineChart({
			marks: [
				dot(scatterRows, {
					x: "occupancy",
					y: "yieldPct",
					r: 6,
					fill: "#8b5cf6",
				}),
			],
			x: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "obłożenie STR %" },
			},
			y: linY("rentowność LT %"),
		});

		// 18. Cena nocna wg miasta (Airbnb vs Booking)
		const nightlyAb = data.nightlyByCity.filter((r) => r.source === "airbnb");
		const nightlyBk = data.nightlyByCity.filter((r) => r.source === "booking");
		const cityOrder = [
			...new Set([...nightlyAb, ...nightlyBk].map((r) => r.city)),
		];
		c.nightlyByCity = defineChart({
			marks: [
				lineY(
					cityOrder.map((city) => ({
						city,
						avg: nightlyAb.find((r) => r.city === city)?.avgNightly ?? null,
					})),
					{ x: "city", y: "avg", stroke: "#ff385c", strokeWidth: 2, points: true },
				),
				lineY(
					cityOrder.map((city) => ({
						city,
						avg: nightlyBk.find((r) => r.city === city)?.avgNightly ?? null,
					})),
					{ x: "city", y: "avg", stroke: "#003580", strokeWidth: 2, points: true },
				),
			],
			x: bandX("Miasto"),
			y: linY("śr. zł/noc"),
		});

		// 19. % ofert z obniżką ceny wg miasta (ostatnie 30 dni)
		c.priceDrops = defineChart({
			marks: [
				barY(data.priceDropsByCity, {
					x: "city",
					y: "dropPct",
					fill: "#dc2626",
				}),
			],
			x: bandX("Miasto"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "% ofert z obniżką" },
			},
		});

		return c;
	}, [data]);

	const chartDefs: Array<{
		title: string;
		subtitle?: string;
		key: string;
		height?: number;
	}> = [
		{
			title: "1 · Liczba ofert wg przedziału czynszu",
			subtitle: `histogram najmu LT — mediana ${data?.rentMeta.median ?? 0} zł, średnia ${data?.rentMeta.avg ?? 0} zł`,
			key: "rentHistogram",
		},
		{
			title: "2 · Liczba ofert wg przedziału opłat (czynsz adm.)",
			subtitle: `histogram opłat — mediana ${data?.oplatyMeta.median ?? 0} zł, średnia ${data?.oplatyMeta.avg ?? 0} zł`,
			key: "oplatyHistogram",
		},
		{
			title: "3 · Liczba ofert wg kosztu łącznego (czynsz + opłaty)",
			subtitle: `histogram kosztu całkowitego — mediana ${data?.totalMeta.median ?? 0} zł, średnia ${data?.totalMeta.avg ?? 0} zł`,
			key: "totalHistogram",
		},
		{
			title: "4 · Trend cen transakcyjnych (RCN + GUGiK, 36 mies.)",
			subtitle: "avg zł/m² — gdzie rynek zmierza",
			key: "priceTrend",
		},
		{
			title: "5 · Wolumen transakcji miesięcznie",
			subtitle: "popyt — wolumen zwykle wyprzedza ceny",
			key: "txVolume",
		},
		{
			title: "6 · Nowe oferty miesięcznie",
			subtitle: "niebieska = sprzedaż, zielona = najem LT, czerwona = STR",
			key: "newSupply",
		},
		{
			title: "7 · Wzrost cen transakcyjnych r/r wg powiatu",
			subtitle: "średnia 12 mies. vs poprzednie 12 (min. 10 transakcji na okno)",
			key: "yoyByPowiat",
		},
		{
			title: "8 · Rentowność najmu długoterminowego wg miasta",
			subtitle: "czynsz roczny / cena sprzedaży",
			key: "grossYield",
		},
		{
			title: "9 · Cena ofertowa vs transakcyjna",
			subtitle: "niebieska = oferty, fioletowa = transakcje — luka = margines negocjacji",
			key: "offerVsTxGap",
		},
		{
			title: "10 · Pierwotny vs wtórny wg powiatu",
			subtitle: "pomarańczowy = pierwotny — premium nowej podaży",
			key: "primaryVsSecondary",
		},
		{
			title: "11 · Cena transakcyjna wg liczby pokoi",
			subtitle: "zł/m² — które typy mieszkań są cenione najwyżej",
			key: "txByRooms",
		},
		{
			title: "12 · Cena ofertowa zł/m² wg metrażu",
			subtitle: "kawalerki zwykle najdroższe za m²",
			key: "areaSegments",
		},
		{
			title: "13 · STR — cena nocna wg miesiąca",
			subtitle: "czerwona = Airbnb, granatowa = Booking — sezonowość",
			key: "strPriceByMonth",
		},
		{
			title: "14 · STR — obłożenie wg miesiąca",
			subtitle: "rezerwacje (bez blokad właścicieli) — szczyty popytu",
			key: "occupancyByMonth",
		},
		{
			title: "15 · STR — cena nocna wg dnia tygodnia",
			subtitle: "premia Pt/So = rynek weekendowy; płasko = najem pracowniczy",
			key: "weekdayPremium",
		},
		{
			title: "16 · STR — obłożenie wg miasta",
			subtitle: "gdzie kalendarze są najpełniej zajęte",
			key: "strOccupancy",
		},
		{
			title: "17 · Obłożenie STR vs rentowność LT",
			subtitle: "prawy górny róg = najlepsze miejsca pod najem inwestycyjny",
			key: "occupancyVsYield",
			height: 300,
		},
		{
			title: "18 · Cena nocna wg miasta (Airbnb vs Booking)",
			subtitle: "czerwona = Airbnb, granatowa = Booking",
			key: "nightlyByCity",
		},
		{
			title: "19 · % ofert z obniżką ceny (30 dni) wg miasta",
			subtitle:
				"udział ogłoszeń, których cena spadła w ciągu ostatnich 30 dni — rośnie z historią snapshots",
			key: "priceDrops",
		},
	];

	if (isLoading) {
		return <div className="p-6 text-sm text-gray-500">Ładowanie...</div>;
	}
	if (error || !data) {
		return (
			<div className="p-6 text-sm text-red-600">
				Nie udało się pobrać danych: {String(error)}
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-gray-50 p-4">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">
					Analityka rynku · Małopolska
				</h1>
				<div className="flex items-center gap-3 text-sm">
					<Link to="/map" className="text-blue-600 underline">
						Mapa
					</Link>
					<Link to="/listings" className="text-blue-600 underline">
						Listings
					</Link>
					<Link to="/sources" className="text-blue-600 underline">
						Data sources
					</Link>
				</div>
			</div>

			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{chartDefs.map((cd) => {
					const def = charts[cd.key];
					if (!def) return null;
					const height = cd.height ?? 280;
					return (
						<div key={cd.key} className="rounded border bg-white p-2">
							<h2 className="px-2 py-1 text-sm font-semibold text-gray-700">
								{cd.title}
							</h2>
							{cd.subtitle && (
								<p className="px-2 pb-1 text-xs text-gray-500">{cd.subtitle}</p>
							)}
							<div style={{ height }}>
								<Chart
									definition={def as never}
									height={height - 14}
									ariaLabel={cd.title}
								/>
							</div>
						</div>
					);
				})}
			</div>

			<div className="mt-4 overflow-x-auto rounded border bg-white">
				<h2 className="px-3 py-2 text-sm font-semibold text-gray-600">
					Okazje — dzielnice przewartościowane vs niedowartościowane
				</h2>
				<table className="w-full text-sm">
					<thead className="bg-gray-50 text-left">
						<tr>
							<th className="px-3 py-2">Dzielnica</th>
							<th className="px-3 py-2 text-right">Cena zł/m²</th>
							<th className="px-3 py-2 text-right">Czynsz zł/m²</th>
							<th className="px-3 py-2 text-right">Rentowność</th>
							<th className="px-3 py-2 text-right">Wartość godziwa</th>
							<th className="px-3 py-2 text-right">Przewart.</th>
							<th className="px-3 py-2 text-right">Zwrot (lata)</th>
						</tr>
					</thead>
					<tbody>
						{(valuation?.rows ?? []).map((r) => (
							<tr key={r.district} className="border-t hover:bg-gray-50">
								<td className="px-3 py-1.5">{r.district}</td>
								<td className="px-3 py-1.5 text-right">
									{Math.round(r.saleAvgM2).toLocaleString("pl-PL")}
								</td>
								<td className="px-3 py-1.5 text-right">
									{r.rentAvgM2.toFixed(1)}
								</td>
								<td className="px-3 py-1.5 text-right">
									{r.grossYieldPct.toFixed(1)}%
								</td>
								<td className="px-3 py-1.5 text-right">
									{Math.round(r.fairPriceM2).toLocaleString("pl-PL")}
								</td>
								<td className="px-3 py-1.5 text-right">
									{r.overUnderPct.toFixed(1)}%
								</td>
								<td className="px-3 py-1.5 text-right">
									{r.paybackYears.toFixed(1)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<p className="mt-4 rounded border bg-white p-3 text-xs text-gray-500">
				Źródła: transakcje RCN Kraków + GUGiK (1.3 mln, aktualizacja dzienna),
				oferty otodom/olx (sprzedaż + najem LT, odświeżanie godzinowe),
				Airbnb/Booking (ceny nocne, kalendarze dostępności — codziennie).
				Obłożenie = sklasyfikowane rezerwacje; blokady właścicieli liczone
				osobno i wykluczone ze współczynnika.
			</p>
		</div>
	);
}
