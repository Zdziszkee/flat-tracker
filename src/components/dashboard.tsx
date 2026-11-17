import { barY, defineChart, dot, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { buildChartCards } from "#/components/analytics/chart-cards";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import { Input } from "#/components/ui/input";
import { Progress } from "#/components/ui/progress";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { cn } from "#/lib/utils";
import type { MarketCharts } from "#/types/market-charts";

interface LastRun {
	startedAt: string | null;
	finishedAt: string | null;
	pages: number | null;
	newCount: number | null;
	updatedCount: number | null;
	error: string | null;
}

interface LiveState {
	source: string;
	state: "pending" | "running" | "ok" | "failed";
	pages?: number;
	newCount?: number;
	updatedCount?: number;
	error?: string;
	log?: string;
}

interface SourceStatus {
	id: string;
	name: string;
	kind:
		| "portal"
		| "rcn"
		| "geocode"
		| "airbnb-calendar"
		| "public-investments"
		| "price-index"
		| "scoring";
	lastRun: LastRun | null;
	live: LiveState | null;
}

interface CrawlStatusResponse {
	running: boolean;
	progress: {
		runId: string;
		status: string;
		startedAt: string;
		finishedAt: string | null;
		phase: string;
	} | null;
	sources: SourceStatus[];
}

interface OccupancyCell {
	lat: number;
	lng: number;
	listings: number;
	sampleNights: number;
	bookedNights: number;
	occupancyRate: number | null;
	avgPrice: number | null;
}

interface TopOccupancyResponse {
	month: string;
	source: string;
	grid: number;
	cells: OccupancyCell[];
}

interface ValuationRow {
	district: string;
	saleAvgM2: number;
	rentAvgM2: number;
	grossYieldPct: number;
	fairPriceM2: number;
	overUnderPct: number;
	paybackYears: number;
}

type TabValue = "analytics" | "sources";

const STALE_MS = 24 * 60 * 60 * 1000;
const DOW = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];

const CHART_THEME = {
	foreground: "#d4d4d8",
	muted: "#a1a1aa",
	grid: "rgba(255,255,255,0.12)",
	background: "transparent",
} as const;

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

function relativeTime(iso: string | null | undefined): string {
	if (!iso) return "never";
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 0) return "just now";
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

function duration(
	startedAt: string | null | undefined,
	finishedAt: string | null | undefined,
): string {
	if (!startedAt || !finishedAt) return "";
	const s =
		(new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000;
	if (s < 0) return "";
	if (s < 60) return `${s.toFixed(0)}s`;
	return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}

type StatusTone = "running" | "ok" | "error" | "idle";

function statusTone(s: SourceStatus): StatusTone {
	if (s.live) {
		switch (s.live.state) {
			case "running":
				return "running";
			case "failed":
				return "error";
			case "ok":
				return "ok";
			default:
				return "idle";
		}
	}
	const last = s.lastRun;
	if (!last) return "idle";
	if (last.error) return "error";
	if (
		last.finishedAt &&
		Date.now() - new Date(last.finishedAt).getTime() > STALE_MS
	) {
		return "error";
	}
	return "ok";
}

function statusLabel(s: SourceStatus): string {
	if (s.live) {
		switch (s.live.state) {
			case "running":
				return "crawling…";
			case "failed":
				return "failed";
			case "ok":
				return "just updated";
			case "pending":
				return "queued";
		}
	}
	const last = s.lastRun;
	if (!last) return "never run";
	if (last.error) return "last run failed";
	if (
		last.finishedAt &&
		Date.now() - new Date(last.finishedAt).getTime() > STALE_MS
	) {
		return "stale";
	}
	return "ok";
}

function StatusBadge({ source }: { source: SourceStatus }) {
	const tone = statusTone(source);
	return (
		<Badge
			variant={tone === "error" ? "destructive" : "secondary"}
			className={cn(tone === "idle" && "bg-transparent border-border")}
		>
			{tone === "running" && (
				<span
					aria-hidden="true"
					className="size-1.5 animate-pulse rounded-full bg-secondary-foreground"
				/>
			)}
			{statusLabel(source)}
		</Badge>
	);
}

function metrics(s: SourceStatus): string {
	if (s.live?.state === "running") return "crawling…";
	if (s.live?.state === "pending") return "queued";
	const run = s.lastRun;
	if (!run) return "—";
	const n = run.newCount ?? 0;
	const u = run.updatedCount ?? 0;
	const p = run.pages ?? 0;
	switch (s.kind) {
		case "rcn":
			return `${n} new transactions`;
		case "geocode":
			return `${n} geocoded`;
		case "airbnb-calendar":
			return `${n} listings · ${u} monthly rows`;
		case "public-investments":
			return `${n} new · ${u} updated projects`;
		case "price-index":
			return `${n} index rows`;
		case "scoring":
			return `${u} scored · ${n} alerts`;
		default:
			return `${p} pages · ${n} new · ${u} updated`;
	}
}

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

function hasFiniteValue(row: unknown, keys: readonly string[]): boolean {
	if (!row || typeof row !== "object") return false;
	const record = row as Record<string, unknown>;
	return keys.some((key) => {
		const value = record[key];
		return typeof value === "number" && Number.isFinite(value);
	});
}

function hasChartValues(
	rows: readonly unknown[] | undefined | null,
	yKeys: string | readonly string[],
	options: { requirePositive?: boolean } = {},
): boolean {
	if (!Array.isArray(rows)) return false;
	const keys = typeof yKeys === "string" ? [yKeys] : yKeys;
	return rows.some((row) =>
		keys.some((key) => {
			const value = (row as Record<string, unknown> | null)?.[key];
			if (typeof value !== "number" || !Number.isFinite(value)) return false;
			return options.requirePositive ? value > 0 : true;
		}),
	);
}

function hasNonZeroChartValues(
	rows: readonly unknown[] | undefined | null,
	yKeys: string | readonly string[],
): boolean {
	return hasChartValues(rows, yKeys, { requirePositive: true });
}

function isChartEmpty(key: string, data: MarketCharts): boolean {
	switch (key) {
		case "rentHistogram":
			return !hasNonZeroChartValues(data.rentHistogram, "n");
		case "oplatyHistogram":
			return !hasNonZeroChartValues(data.oplatyHistogram, "n");
		case "totalHistogram":
			return !hasNonZeroChartValues(data.totalHistogram, "n");
		case "priceTrend":
			return !hasChartValues(data.priceTrend, "avgM2");
		case "txVolume":
			return !hasNonZeroChartValues(data.txVolume, "tx");
		case "newSupply":
			return !["sprzedaż", "najem", "STR"].some((segment) =>
				hasNonZeroChartValues(
					data.newSupply?.filter((r) => r.segment === segment),
					"n",
				),
			);
		case "yoyByPowiat":
			return !hasChartValues(data.yoyByPowiat, "growthPct");
		case "grossYield":
			return !hasChartValues(data.grossYieldByCity, "yieldPct");
		case "offerVsTxGap":
			return !hasChartValues(data.offerVsTxGap, ["askM2", "txM2"]);
		case "primaryVsSecondary":
			return !hasChartValues(data.primaryVsSecondary, ["wtorny", "pierwotny"]);
		case "txByRooms":
			return !hasChartValues(data.txByRooms, "avgM2");
		case "areaSegments":
			return !hasChartValues(data.areaSegments, "avgM2");
		case "strPriceByMonth":
			return !["airbnb", "booking"].some((source) =>
				hasChartValues(
					data.strPriceByMonth?.filter((r) => r.source === source),
					"avgPrice",
				),
			);
		case "occupancyByMonth":
			return !hasChartValues(data.occupancyByMonth, "occupancy");
		case "weekdayPremium":
			return !hasChartValues(data.weekdayPremium, "avgPrice");
		case "strOccupancy":
			return !hasChartValues(data.strOccupancyByCity, "occupancy");
		case "occupancyVsYield": {
			const citiesWithOccupancy = new Set(
				(data.strOccupancyByCity ?? [])
					.filter((r) => hasFiniteValue(r, ["occupancy"]))
					.map((r) => r.city),
			);
			return !hasChartValues(
				(data.grossYieldByCity ?? []).filter((r) =>
					citiesWithOccupancy.has(r.city),
				),
				"yieldPct",
			);
		}
		case "nightlyByCity":
			return !["airbnb", "booking"].some((source) =>
				hasChartValues(
					data.nightlyByCity?.filter((r) => r.source === source),
					"avgNightly",
				),
			);
		case "priceDrops":
			return !hasNonZeroChartValues(data.priceDropsByCity, "dropPct");
		default:
			return false;
	}
}

/** The main page owns both live data views; /analytics and /sources reuse it. */
export function Dashboard({
	defaultTab = "analytics",
}: {
	defaultTab?: TabValue;
}) {
	const [tab, setTab] = useState<TabValue>(defaultTab);
	return (
		<Tabs
			value={tab}
			onValueChange={(value) => setTab(value as TabValue)}
			className="gap-6"
		>
			<TabsList aria-label="Panel danych">
				<TabsTrigger value="analytics">Analiza inwestycyjna</TabsTrigger>
				<TabsTrigger value="sources">Źródła danych</TabsTrigger>
			</TabsList>
			<TabsContent value="analytics" className="mt-0">
				<AnalyticsPanel />
			</TabsContent>
			<TabsContent value="sources" className="mt-0">
				<SourcesPanel />
			</TabsContent>
		</Tabs>
	);
}

function AnalyticsPanel() {
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
	const { data: topOccupancy } = useQuery<TopOccupancyResponse>({
		queryKey: ["top-occupancy-areas", occSource, occMonth],
		queryFn: () =>
			fetch(
				`/api/top-occupancy-areas?source=${occSource}&month=${occMonth}&limit=20&minListings=1`,
			).then((r) => r.json()),
	});

	const charts = useMemo(() => {
		if (!data) return {};
		const c: Record<string, unknown> = {};

		c.rentHistogram = defineChart({
			marks: [
				barY(data.rentHistogram, { x: "label", y: "n", fill: SERIES.blue }),
			],
			x: bandX("Czynsz mies. (zł)"),
			y: linY("liczba ofert"),
			theme: CHART_THEME,
		});
		c.oplatyHistogram = defineChart({
			marks: [
				barY(data.oplatyHistogram, {
					x: "label",
					y: "n",
					fill: SERIES.amber,
				}),
			],
			x: bandX("Czynsz adm. (zł)"),
			y: linY("liczba ofert"),
			theme: CHART_THEME,
		});
		c.totalHistogram = defineChart({
			marks: [
				barY(data.totalHistogram, { x: "label", y: "n", fill: SERIES.green }),
			],
			x: bandX("Czynsz + opłaty (zł/mies.)"),
			y: linY("liczba ofert"),
			theme: CHART_THEME,
		});
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
		c.txVolume = defineChart({
			marks: [barY(data.txVolume, { x: "month", y: "tx", fill: SERIES.blue })],
			x: bandX("Miesiąc"),
			y: linY("liczba transakcji"),
			theme: CHART_THEME,
		});
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
			y: linY("wzrost % r/r"),
			theme: CHART_THEME,
		});
		const yieldSorted = [...data.grossYieldByCity].sort(
			(a, b) => b.yieldPct - a.yieldPct,
		);
		c.grossYield = defineChart({
			marks: [
				barY(yieldSorted, {
					x: "city",
					y: "yieldPct",
					fill: SERIES.emerald,
				}),
			],
			x: bandX("Miasto"),
			y: linY("rentowność brutto %"),
			theme: CHART_THEME,
		});
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
		c.txByRooms = defineChart({
			marks: [
				barY(data.txByRooms, {
					x: "label",
					y: "avgM2",
					fill: SERIES.cyan,
				}),
			],
			x: bandX("Liczba pokoi"),
			y: linY("zł/m²"),
			theme: CHART_THEME,
		});
		c.areaSegments = defineChart({
			marks: [
				barY(data.areaSegments, {
					x: "label",
					y: "avgM2",
					fill: SERIES.cyan,
				}),
			],
			x: bandX("Metraż"),
			y: linY("zł/m²"),
			theme: CHART_THEME,
		});
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
		c.occupancyByMonth = defineChart({
			marks: [
				barY(data.occupancyByMonth, {
					x: "month",
					y: "occupancy",
					fill: SERIES.teal,
				}),
			],
			x: bandX("Miesiąc"),
			y: linY("obłożenie (0-1)"),
			theme: CHART_THEME,
		});
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
		const occSorted = [...data.strOccupancyByCity].sort(
			(a, b) => (b.occupancy ?? 0) - (a.occupancy ?? 0),
		);
		c.strOccupancy = defineChart({
			marks: [
				barY(occSorted, {
					x: "city",
					y: "occupancy",
					fill: SERIES.tealDeep,
				}),
			],
			x: bandX("Miasto"),
			y: linY("obłożenie (0-1)"),
			theme: CHART_THEME,
		});
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
		c.priceDrops = defineChart({
			marks: [
				barY(data.priceDropsByCity, {
					x: "city",
					y: "dropPct",
					fill: SERIES.red,
				}),
			],
			x: bandX("Miasto"),
			y: linY("% ofert z obniżką"),
			theme: CHART_THEME,
		});
		return c;
	}, [data]);

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

function SourcesPanel() {
	const queryClient = useQueryClient();
	const { data, isLoading } = useQuery<CrawlStatusResponse>({
		queryKey: ["crawl-status"],
		queryFn: () => fetch("/api/crawl-status").then((r) => r.json()),
		refetchInterval: (query) => (query.state.data?.running ? 2000 : 15000),
	});
	const refresh = useMutation({
		mutationFn: async () => {
			const res = await fetch("/api/refresh", { method: "POST" });
			return (await res.json()) as {
				started: boolean;
				alreadyRunning: boolean;
			};
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["crawl-status"] });
		},
	});

	const running = data?.running ?? false;
	const sources = data?.sources ?? [];
	const doneCount = sources.filter(
		(s) => s.live?.state === "ok" || s.live?.state === "failed",
	).length;
	const pct =
		sources.length > 0 ? Math.round((doneCount / sources.length) * 100) : 0;
	const refreshBusy = running || refresh.isPending;

	return (
		<div className="flex flex-col gap-4">
			<Card className="gap-3 py-4">
				<CardHeader className="px-4">
					<CardTitle className="text-sm">Stan odświeżania</CardTitle>
					<CardDescription className="text-xs">
						Ostatni przebieg każdego źródła. Status starszy niż 24h wymaga
						odświeżenia.
					</CardDescription>
					<CardAction className="flex items-center gap-3">
						<span className="text-sm text-muted-foreground">
							{running ? "W toku…" : "Bezczynne"}
						</span>
						<Button
							type="button"
							size="sm"
							onClick={() => refresh.mutate()}
							disabled={refreshBusy}
						>
							<RefreshCwIcon
								data-icon="inline-start"
								className={cn(refreshBusy && "animate-spin")}
							/>
							{running ? "Trwa…" : "Odśwież teraz"}
						</Button>
					</CardAction>
				</CardHeader>
				{running && (
					<CardContent className="px-4">
						<div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
							<span>Etap: {data?.progress?.phase ?? "crawl"}</span>
							<span className="tabular-nums">
								{doneCount}/{sources.length}
							</span>
						</div>
						<Progress value={pct} aria-label="Postęp odświeżania" />
					</CardContent>
				)}
			</Card>

			{refresh.data?.alreadyRunning && (
				<Alert>
					<AlertDescription>
						Odświeżanie już trwa — pokazujemy jego bieżący postęp.
					</AlertDescription>
				</Alert>
			)}
			{refresh.isError && (
				<Alert variant="destructive">
					<AlertTitle>Nie udało się uruchomić odświeżania</AlertTitle>
					<AlertDescription>Spróbuj ponownie za chwilę.</AlertDescription>
				</Alert>
			)}

			<Card className="gap-0 overflow-hidden py-0">
				<Table>
					<TableHeader>
						<TableRow className="bg-muted/50 hover:bg-muted/50">
							<TableHead className="w-[34%] px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Źródło
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Ostatnie sprawdzenie
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Czas trwania
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Wynik
							</TableHead>
							<TableHead className="px-4 text-xs uppercase tracking-wide text-muted-foreground">
								Błąd
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{isLoading &&
							[0, 1, 2, 3, 4, 5].map((row) => (
								<TableRow key={row}>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-32" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-24" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-12" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-28" />
									</TableCell>
									<TableCell className="px-4 py-2">
										<Skeleton className="h-4 w-16" />
									</TableCell>
								</TableRow>
							))}
						{sources.map((s) => {
							const error =
								s.live?.error || s.live?.log || s.lastRun?.error || "";
							return (
								<TableRow key={s.id}>
									<TableCell className="max-w-0 px-4 py-2">
										<div className="flex items-center gap-2">
											<span className="truncate font-medium">{s.name}</span>
											<span className="text-xs text-muted-foreground">
												({s.id})
											</span>
										</div>
									</TableCell>
									<TableCell className="px-4 py-2">
										<div className="flex items-center gap-2">
											<span className="text-muted-foreground tabular-nums">
												{relativeTime(s.lastRun?.finishedAt)}
											</span>
											<StatusBadge source={s} />
										</div>
									</TableCell>
									<TableCell className="px-4 py-2 text-muted-foreground tabular-nums">
										{duration(s.lastRun?.startedAt, s.lastRun?.finishedAt)}
									</TableCell>
									<TableCell className="px-4 py-2">{metrics(s)}</TableCell>
									<TableCell className="max-w-xs px-4 py-2 text-destructive-foreground">
										{error ? (
											<Collapsible className="group">
												<CollapsibleTrigger className="flex w-full cursor-pointer items-start gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
													<ChevronRightIcon
														aria-hidden="true"
														className="mt-0.5 size-3.5 shrink-0 transition-transform group-open:rotate-90"
													/>
													<span className="line-clamp-2 break-words">
														{error}
													</span>
												</CollapsibleTrigger>
												<CollapsibleContent>
													<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs leading-relaxed">
														{error}
													</pre>
												</CollapsibleContent>
											</Collapsible>
										) : null}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
