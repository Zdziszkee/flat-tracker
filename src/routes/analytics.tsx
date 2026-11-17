import { barY, defineChart, dot, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { buildChartCards } from "#/components/analytics/chart-cards";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { DEFAULT_LISTING_SEARCH } from "#/lib/listing-features";
import type { MarketCharts, ValuationRow } from "#/types/market-charts";

/**
 * Analityka rynku — 19 wykresów: najem (histogramy czynszu, opłat i
 * kosztu łącznego), transakcje RCN/GUGiK (trend, wolumen, pokoje,
 * pierwotny vs wtórny), podaż ofert, rentowność LT i najem
 * krótkoterminowy (ceny, obłożenie, sezonowość, dzień tygodnia).
 */

const DOW = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];

/** Explicit dark theme for chart guides (zinc ticks, faint white grid). */
const CHART_THEME = {
	foreground: "#d4d4d8",
	muted: "#a1a1aa",
	grid: "rgba(255,255,255,0.12)",
	background: "transparent",
} as const;

/**
 * Series hues brightened for the dark card surface. Brand pairs stay
 * recognizable (Airbnb rose, Booking blue) and every multi-series chart
 * keeps its colors visually distinct.
 */
const SERIES = {
	blue: "#60a5fa",
	amber: "#fbbf24",
	green: "#4ade80",
	violet: "#a78bfa",
	emerald: "#34d399",
	rose: "#fb7185",
	orange: "#fb923c",
	cyan: "#22d3ee",
	teal: "#2dd4bf",
	tealDeep: "#14b8a6",
	red: "#f87171",
	slate: "#94a3b8",
	booking: "#3b82f6",
	dotViolet: "#c084fc",
} as const;

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

	interface OccupancyCell {
		lat: number;
		lng: number;
		listings: number;
		sampleNights: number;
		bookedNights: number;
		occupancyRate: number | null;
		avgPrice: number | null;
	}
	const [occSource, setOccSource] = useState<"airbnb" | "booking" | "all">(
		"all",
	);
	const [occMonth, setOccMonth] = useState(() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	});
	const { data: topOccupancy } = useQuery<{
		month: string;
		source: string;
		grid: number;
		cells: OccupancyCell[];
	}>({
		queryKey: ["top-occupancy-areas", occSource, occMonth],
		queryFn: () =>
			fetch(
				`/api/top-occupancy-areas?source=${occSource}&month=${occMonth}&limit=20&minListings=1`,
			).then((r) => r.json()),
	});

	const charts = useMemo<{ [key: string]: unknown }>(() => {
		if (!data) return {};
		const c: { [key: string]: unknown } = {};

		// 1. Liczba ofert wg przedziału czynszu (histogram najmu LT)
		c.rentHistogram = defineChart({
			marks: [
				barY(data.rentHistogram, { x: "label", y: "n", fill: SERIES.blue }),
			],
			x: bandX("Czynsz mies. (zł)"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "liczba ofert" },
			},
			theme: CHART_THEME,
		});

		// 2. Liczba ofert wg przedziału opłat (czynsz adm.)
		c.oplatyHistogram = defineChart({
			marks: [
				barY(data.oplatyHistogram, { x: "label", y: "n", fill: SERIES.amber }),
			],
			x: bandX("Czynsz adm. (zł)"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "liczba ofert" },
			},
			theme: CHART_THEME,
		});

		// 3. Liczba ofert wg kosztu łącznego (czynsz + opłaty)
		c.totalHistogram = defineChart({
			marks: [
				barY(data.totalHistogram, { x: "label", y: "n", fill: SERIES.green }),
			],
			x: bandX("Czynsz + opłaty (zł/mies.)"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "liczba ofert" },
			},
			theme: CHART_THEME,
		});

		// 4. Trend cen transakcyjnych
		c.priceTrend = defineChart({
			marks: [
				lineY(data.priceTrend, {
					x: "month",
					y: "avgM2",
					stroke: SERIES.violet,
					strokeWidth: 2,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("zł/m² (transakcje)"),
			theme: CHART_THEME,
		});

		// 5. Wolumen transakcji miesięcznie
		c.txVolume = defineChart({
			marks: [barY(data.txVolume, { x: "month", y: "tx", fill: SERIES.blue })],
			x: bandX("Miesiąc"),
			y: linY("liczba transakcji"),
			theme: CHART_THEME,
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
					stroke: SERIES.blue,
					strokeWidth: 2,
				}),
				lineY(supplyRent, {
					x: "month",
					y: "n",
					stroke: SERIES.emerald,
					strokeWidth: 2,
				}),
				lineY(supplyStr, {
					x: "month",
					y: "n",
					stroke: SERIES.rose,
					strokeWidth: 1.5,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("nowe oferty"),
			theme: CHART_THEME,
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
					fill: (d) => ((d.growthPct ?? 0) >= 0 ? SERIES.green : SERIES.red),
				}),
			],
			x: bandX("Powiat"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "wzrost % r/r" },
			},
			theme: CHART_THEME,
		});

		// 8. Rentowność najmu LT wg miasta
		const yieldSorted = [...data.grossYieldByCity].sort(
			(a, b) => b.yieldPct - a.yieldPct,
		);
		c.grossYield = defineChart({
			marks: [
				barY(yieldSorted, { x: "city", y: "yieldPct", fill: SERIES.emerald }),
			],
			x: bandX("Miasto"),
			y: linY("rentowność brutto %"),
			theme: CHART_THEME,
		});

		// 9. Luka oferta vs transakcja
		c.offerVsTxGap = defineChart({
			marks: [
				lineY(data.offerVsTxGap, {
					x: "month",
					y: "askM2",
					stroke: SERIES.blue,
					strokeWidth: 2,
				}),
				lineY(data.offerVsTxGap, {
					x: "month",
					y: "txM2",
					stroke: SERIES.violet,
					strokeWidth: 2,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("zł/m²"),
			theme: CHART_THEME,
		});

		// 10. Pierwotny vs wtórny wg powiatu
		c.primaryVsSecondary = defineChart({
			marks: [
				barY(data.primaryVsSecondary, {
					x: "powiat",
					y: "wtorny",
					fill: SERIES.slate,
				}),
				barY(data.primaryVsSecondary, {
					x: "powiat",
					y: "pierwotny",
					fill: SERIES.orange,
				}),
			],
			x: bandX("Powiat"),
			y: linY("zł/m²"),
			theme: CHART_THEME,
		});

		// 11. Cena transakcyjna wg liczby pokoi
		c.txByRooms = defineChart({
			marks: [
				barY(data.txByRooms, { x: "label", y: "avgM2", fill: SERIES.cyan }),
			],
			x: bandX("Liczba pokoi"),
			y: linY("zł/m²"),
			theme: CHART_THEME,
		});

		// 12. Cena ofertowa zł/m² wg metrażu
		c.areaSegments = defineChart({
			marks: [
				barY(data.areaSegments, { x: "label", y: "avgM2", fill: SERIES.cyan }),
			],
			x: bandX("Metraż"),
			y: linY("zł/m²"),
			theme: CHART_THEME,
		});

		// 13. STR cena nocna wg miesiąca (Airbnb vs Booking)
		const abMonth = data.strPriceByMonth.filter((r) => r.source === "airbnb");
		const bkMonth = data.strPriceByMonth.filter((r) => r.source === "booking");
		c.strPriceByMonth = defineChart({
			marks: [
				lineY(abMonth, {
					x: "month",
					y: "avgPrice",
					stroke: SERIES.rose,
					strokeWidth: 2,
					points: true,
				}),
				lineY(bkMonth, {
					x: "month",
					y: "avgPrice",
					stroke: SERIES.booking,
					strokeWidth: 2,
					points: true,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("śr. zł/noc"),
			theme: CHART_THEME,
		});

		// 14. STR obłożenie wg miesiąca
		c.occupancyByMonth = defineChart({
			marks: [
				barY(data.occupancyByMonth, {
					x: "month",
					y: "occupancy",
					fill: SERIES.teal,
				}),
			],
			x: bandX("Miesiąc"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "obłożenie (0-1)" },
			},
			theme: CHART_THEME,
		});

		// 15. Premia weekendowa — cena wg dnia tygodnia check-inu
		const dowRows = data.weekdayPremium.map((r) => ({
			...r,
			day: DOW[r.weekday] ?? String(r.weekday),
		}));
		c.weekdayPremium = defineChart({
			marks: [barY(dowRows, { x: "day", y: "avgPrice", fill: SERIES.amber })],
			x: bandX("Dzień tygodnia (check-in)"),
			y: linY("śr. zł/noc"),
			theme: CHART_THEME,
		});

		// 16. STR obłożenie wg miasta
		const occSorted = [...data.strOccupancyByCity].sort(
			(a, b) => (b.occupancy ?? 0) - (a.occupancy ?? 0),
		);
		c.strOccupancy = defineChart({
			marks: [
				barY(occSorted, { x: "city", y: "occupancy", fill: SERIES.tealDeep }),
			],
			x: bandX("Miasto"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "obłożenie (0-1)" },
			},
			theme: CHART_THEME,
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
					fill: SERIES.dotViolet,
				}),
			],
			x: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "obłożenie STR %" },
			},
			y: linY("rentowność LT %"),
			theme: CHART_THEME,
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
					{
						x: "city",
						y: "avg",
						stroke: SERIES.rose,
						strokeWidth: 2,
						points: true,
					},
				),
				lineY(
					cityOrder.map((city) => ({
						city,
						avg: nightlyBk.find((r) => r.city === city)?.avgNightly ?? null,
					})),
					{
						x: "city",
						y: "avg",
						stroke: SERIES.booking,
						strokeWidth: 2,
						points: true,
					},
				),
			],
			x: bandX("Miasto"),
			y: linY("śr. zł/noc"),
			theme: CHART_THEME,
		});

		// 19. % ofert z obniżką ceny wg miasta (ostatnie 30 dni)
		c.priceDrops = defineChart({
			marks: [
				barY(data.priceDropsByCity, {
					x: "city",
					y: "dropPct",
					fill: SERIES.red,
				}),
			],
			x: bandX("Miasto"),
			y: {
				scale: scaleLinear,
				nice: true,
				grid: true,
				axis: { label: "% ofert z obniżką" },
			},
			theme: CHART_THEME,
		});

		return c;
	}, [data]);

	if (isLoading) {
		return (
			<div className="min-h-screen p-4">
				<Skeleton className="mb-4 h-8 w-96 max-w-full" />
				<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
					{Array.from({ length: 6 }, (_, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
						<Card key={i} aria-hidden="true">
							<CardHeader>
								<Skeleton className="h-4 w-2/3" />
								<Skeleton className="h-3 w-1/2" />
							</CardHeader>
							<CardContent>
								<Skeleton className="h-[240px] w-full" />
							</CardContent>
						</Card>
					))}
				</div>
				<span className="sr-only">Ładowanie...</span>
			</div>
		);
	}
	if (error || !data) {
		return (
			<div className="p-6">
				<Alert variant="destructive">
					<AlertTitle>Nie udało się pobrać danych</AlertTitle>
					<AlertDescription>{String(error)}</AlertDescription>
				</Alert>
			</div>
		);
	}

	const chartDefs = buildChartCards(data);

	return (
		<div className="min-h-screen p-4">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">
					Analityka rynku · Małopolska i Śląsk
				</h1>
				<div className="flex items-center gap-3 text-sm">
					<Link
						to="/map"
						search={DEFAULT_LISTING_SEARCH}
						className="text-primary underline underline-offset-4"
					>
						Mapa
					</Link>
					<Link
						to="/listings"
						search={DEFAULT_LISTING_SEARCH}
						className="text-primary underline underline-offset-4"
					>
						Listings
					</Link>
					<Link
						to="/sources"
						className="text-primary underline underline-offset-4"
					>
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
						<Card key={cd.key} className="gap-4 py-4">
							<CardHeader className="px-4">
								<CardTitle className="text-sm">{cd.title}</CardTitle>
								{cd.subtitle && (
									<CardDescription className="text-xs">
										{cd.subtitle}
									</CardDescription>
								)}
							</CardHeader>
							<CardContent className="px-4">
								<div style={{ height }}>
									<Chart
										definition={def as never}
										height={height - 14}
										ariaLabel={cd.title}
									/>
								</div>
							</CardContent>
						</Card>
					);
				})}
			</div>

			<Card className="mt-4 gap-4 py-4">
				<CardHeader className="px-4">
					<CardTitle className="text-sm">
						Najwyższe obłożenie STR — top 20 komórek
					</CardTitle>
					<CardAction className="flex items-center gap-2">
						<Select
							value={occSource}
							onValueChange={(v) =>
								setOccSource(v as "airbnb" | "booking" | "all")
							}
						>
							<SelectTrigger
								size="sm"
								aria-label="Źródło obłożenia"
								className="text-xs"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									<SelectItem value="all">Airbnb + Booking</SelectItem>
									<SelectItem value="airbnb">Airbnb</SelectItem>
									<SelectItem value="booking">Booking</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
						<Input
							type="month"
							value={occMonth}
							onChange={(e) => setOccMonth(e.target.value)}
							aria-label="Miesiąc obłożenia"
							className="h-8 w-auto text-xs"
						/>
					</CardAction>
				</CardHeader>
				<CardContent className="px-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="px-4">#</TableHead>
								<TableHead className="px-4">Współrzędne</TableHead>
								<TableHead className="px-4 text-right">Obłożenie</TableHead>
								<TableHead className="px-4 text-right">Ofert</TableHead>
								<TableHead className="px-4 text-right">
									Zarezerwowane noce
								</TableHead>
								<TableHead className="px-4 text-right">Śr. cena/noc</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{(topOccupancy?.cells ?? []).map((c, i) => (
								<TableRow key={`${c.lat}-${c.lng}`}>
									<TableCell className="px-4 py-1.5">{i + 1}</TableCell>
									<TableCell className="px-4 py-1.5 font-mono text-xs text-muted-foreground">
										{c.lat.toFixed(3)}, {c.lng.toFixed(3)}
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right font-medium">
										{c.occupancyRate != null
											? `${c.occupancyRate.toFixed(1)}%`
											: "n/d"}
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{c.listings}
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{c.bookedNights}
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{c.avgPrice != null
											? `${Math.round(c.avgPrice).toLocaleString("pl-PL")} zł`
											: "n/d"}
									</TableCell>
								</TableRow>
							))}
							{topOccupancy?.cells.length === 0 && (
								<TableRow>
									<TableCell
										colSpan={6}
										className="px-4 py-4 text-center text-xs text-muted-foreground"
									>
										Brak danych obłożenia dla wybranego miesiąca. Uruchom
										kalendarze Airbnb/Booking, aby zebrać dane.
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<Card className="mt-4 gap-4 py-4">
				<CardHeader className="px-4">
					<CardTitle className="text-sm">
						Okazje — dzielnice przewartościowane vs niedowartościowane
					</CardTitle>
				</CardHeader>
				<CardContent className="px-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="px-4">Dzielnica</TableHead>
								<TableHead className="px-4 text-right">Cena zł/m²</TableHead>
								<TableHead className="px-4 text-right">Czynsz zł/m²</TableHead>
								<TableHead className="px-4 text-right">Rentowność</TableHead>
								<TableHead className="px-4 text-right">
									Wartość godziwa
								</TableHead>
								<TableHead className="px-4 text-right">Przewart.</TableHead>
								<TableHead className="px-4 text-right">Zwrot (lata)</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{(valuation?.rows ?? []).map((r) => (
								<TableRow key={r.district}>
									<TableCell className="px-4 py-1.5">{r.district}</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{Math.round(r.saleAvgM2).toLocaleString("pl-PL")}
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{r.rentAvgM2.toFixed(1)}
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{r.grossYieldPct.toFixed(1)}%
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{Math.round(r.fairPriceM2).toLocaleString("pl-PL")}
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{r.overUnderPct.toFixed(1)}%
									</TableCell>
									<TableCell className="px-4 py-1.5 text-right">
										{r.paybackYears.toFixed(1)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<Card className="mt-4 py-3">
				<CardContent className="px-4 text-xs text-muted-foreground">
					Źródła: transakcje RCN Kraków + GUGiK (1.3 mln, aktualizacja dzienna),
					oferty otodom/olx (sprzedaż + najem LT, odświeżanie godzinowe),
					Airbnb/Booking (ceny nocne, kalendarze dostępności — codziennie).
					Obłożenie = sklasyfikowane rezerwacje; blokady właścicieli liczone
					osobno i wykluczone ze współczynnika.
				</CardContent>
			</Card>
		</div>
	);
}
