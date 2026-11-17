import { Chart } from "@tanstack/charts/react";
import { useQuery } from "@tanstack/react-query";
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
import type { MarketCharts } from "#/types/market-charts";
import type { OccupancyHeatmap } from "#/types/occupancy";
import { buildChartDefinitions } from "./chart-definitions";
import { isChartEmpty } from "./chart-emptiness";

interface ValuationRow {
	district: string;
	saleAvgM2: number;
	rentAvgM2: number;
	grossYieldPct: number;
	fairPriceM2: number;
	overUnderPct: number;
	paybackYears: number;
}

/**
 * "Analiza inwestycyjna" panel: the chart grid, the top STR occupancy cells
 * and the district over/under-valuation table.
 */
export function AnalyticsPanel() {
	const { data, isLoading, error } = useQuery<MarketCharts>({
		queryKey: ["market-charts"],
		queryFn: () => fetch("/api/market-charts").then((r) => r.json()),
		staleTime: 5 * 60 * 1000,
	});
	const { data: valuation } = useQuery<{ rows: ValuationRow[] }>({
		queryKey: ["valuation"],
		queryFn: () => fetch("/api/valuation").then((r) => r.json()),
	});

	const [occSource, setOccSource] = useState<"airbnb" | "booking" | "all">(
		"all",
	);
	const [occMonth, setOccMonth] = useState(() => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
	});
	const { data: topOccupancy } = useQuery<OccupancyHeatmap>({
		queryKey: ["top-occupancy-areas", occSource, occMonth],
		queryFn: () =>
			fetch(
				`/api/top-occupancy-areas?source=${occSource}&month=${occMonth}&limit=20&minListings=1`,
			).then((r) => r.json()),
	});

	const charts = useMemo(
		() => (data ? buildChartDefinitions(data) : {}),
		[data],
	);

	if (isLoading) {
		return (
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
				<span className="sr-only">Ładowanie...</span>
			</div>
		);
	}
	if (error || !data) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Nie udało się pobrać danych</AlertTitle>
				<AlertDescription>{String(error)}</AlertDescription>
			</Alert>
		);
	}

	const chartDefs = buildChartCards(data);

	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
				{chartDefs.map((cd) => {
					const def = charts[cd.key];
					if (!def) return null;
					const height = cd.height ?? 280;
					const empty = isChartEmpty(cd.key, data);
					return (
						<Card key={cd.key} className="gap-4 py-4">
							<CardHeader className="px-4">
								<CardTitle className="text-sm">{cd.title}</CardTitle>
								{(cd.subtitle || empty) && (
									<CardDescription className="text-xs">
										{cd.subtitle}
										{empty && (
											<span className="text-muted-foreground">
												{cd.subtitle ? " · " : ""}brak danych
											</span>
										)}
									</CardDescription>
								)}
							</CardHeader>
							<CardContent className="px-4">
								{empty ? (
									<div
										className="flex items-center justify-center text-sm text-muted-foreground"
										style={{ height }}
									>
										Brak danych dla tego wykresu.
									</div>
								) : (
									<div style={{ height }}>
										<Chart
											definition={def as never}
											height={height - 14}
											ariaLabel={cd.title}
										/>
									</div>
								)}
							</CardContent>
						</Card>
					);
				})}
			</div>

			<Card className="gap-4 py-4">
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
										Brak danych obłożenia dla wybranego miesiąca.
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<Card className="gap-4 py-4">
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

			<Card className="py-3">
				<CardContent className="px-4 text-xs text-muted-foreground">
					Źródła: transakcje RCN Kraków + GUGiK, oferty portali, Airbnb/Booking.
					Obłożenie liczy potwierdzone rezerwacje, bez blokad właścicieli.
				</CardContent>
			</Card>
		</div>
	);
}
