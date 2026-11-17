import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, Map as MapIcon, SearchX } from "lucide-react";
import { useState } from "react";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Skeleton } from "#/components/ui/skeleton";
import { useAlerts } from "#/hooks/use-alerts";
import { formatNumber } from "#/lib/format";
import type { ListingSearch } from "#/lib/listing-features";
import type { AlertSegment } from "#/lib/scoring/config";
import { cn } from "#/lib/utils";
import type { AlertDto } from "#/types/alerts";

export const Route = createFileRoute("/alerts")({
	component: AlertsPage,
});

const REGION_LABELS: Record<string, string> = {
	malopolskie: "Małopolska",
	slaskie: "Śląsk",
};

/** Display order for the per-region groups inside a section. */
const REGION_ORDER = ["malopolskie", "slaskie"];

/** The three sections are always rendered, in this order, even when empty. */
const SECTIONS: ReadonlyArray<{
	segment: AlertSegment;
	label: string;
	mapKind: NonNullable<ListingSearch["kind"]>;
}> = [
	{ segment: "flat", label: "Mieszkania", mapKind: "apartment" },
	{ segment: "house", label: "Domy z działką", mapKind: "house" },
	{ segment: "plot", label: "Działki", mapKind: "plot" },
];

function offerCount(count: number): string {
	const mod10 = count % 10;
	const mod100 = count % 100;
	const noun =
		count === 1
			? "oferta"
			: mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
				? "oferty"
				: "ofert";
	return `${count} ${noun}`;
}

function AlertsPage() {
	const [region, setRegion] = useState("all");
	const { data, isLoading } = useAlerts({
		region: region === "all" ? undefined : region,
	});

	const bySegment = new Map<string, AlertDto[]>();
	for (const alert of data?.alerts ?? []) {
		const group = bySegment.get(alert.segment) ?? [];
		group.push(alert);
		bySegment.set(alert.segment, group);
	}

	return (
		<div className="p-6">
			<div className="mb-4 flex flex-wrap items-end justify-between gap-3">
				<div>
					<h1 className="text-balance text-xl font-semibold">Alerty dnia</h1>
					<p className="text-sm text-muted-foreground">
						Top 5% ofert na sprzedaż w trzech segmentach: mieszkania, domy i
						działki. Co najmniej 10% taniej od mediany podobnych z okolicy,
						osobno dla regionu i segmentu. Nowe oferty są oceniane po każdym
						odświeżeniu danych. Data: {data?.date ?? "…"}
					</p>
				</div>
				<div className="flex flex-wrap items-end gap-3">
					<div className="flex flex-col gap-1">
						<Label className="text-xs text-muted-foreground">Region</Label>
						<Select value={region} onValueChange={setRegion}>
							<SelectTrigger className="w-[160px]" aria-label="Region">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">Wszystkie</SelectItem>
								<SelectItem value="malopolskie">Małopolska</SelectItem>
								<SelectItem value="slaskie">Śląsk</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<Button variant="link" size="sm" asChild>
						<Link to="/">Start</Link>
					</Button>
					<Button variant="link" size="sm" asChild>
						<Link to="/listings">Ogłoszenia</Link>
					</Button>
				</div>
			</div>

			{isLoading && <output className="sr-only">Ładowanie alertów…</output>}

			<div className="flex flex-col gap-8">
				{SECTIONS.map(({ segment, label, mapKind }) => {
					const alerts = bySegment.get(segment) ?? [];
					return (
						<section key={segment} aria-labelledby={`section-${segment}`}>
							<h2
								id={`section-${segment}`}
								className="mb-2 text-lg font-semibold"
							>
								{label}{" "}
								<span className="text-sm font-normal text-muted-foreground tabular-nums">
									· top 5% · {offerCount(alerts.length)}
								</span>
							</h2>
							{isLoading ? (
								<div className="grid gap-3 xl:grid-cols-2">
									<Skeleton className="h-64 rounded-xl" />
									<Skeleton className="h-64 rounded-xl" />
								</div>
							) : alerts.length === 0 ? (
								<Empty className="border border-border">
									<EmptyHeader>
										<EmptyMedia variant="icon">
											<SearchX aria-hidden="true" />
										</EmptyMedia>
										<EmptyTitle>Brak alertów w tym segmencie</EmptyTitle>
										<EmptyDescription>
											Brak ofert spełniających progi w tym segmencie. Lista
											uzupełnia się automatycznie po każdym odświeżeniu danych.
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							) : (
								<RegionGroups alerts={alerts} mapKind={mapKind} />
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
}

/**
 * Cards grouped by region. A small subheading appears only when both regions
 * are present (a single-region view needs no extra hierarchy).
 */
function RegionGroups({
	alerts,
	mapKind,
}: {
	alerts: AlertDto[];
	mapKind: NonNullable<ListingSearch["kind"]>;
}) {
	const byRegion = new Map<string, AlertDto[]>();
	for (const alert of alerts) {
		const group = byRegion.get(alert.region) ?? [];
		group.push(alert);
		byRegion.set(alert.region, group);
	}
	const orderOf = (region: string) => {
		const index = REGION_ORDER.indexOf(region);
		return index === -1 ? REGION_ORDER.length : index;
	};
	const regions = [...byRegion.keys()].sort((a, b) => orderOf(a) - orderOf(b));
	const grouped = regions.length > 1;

	return (
		<div className="flex flex-col gap-4">
			{regions.map((region) => {
				const regionAlerts = byRegion.get(region) ?? [];
				const label = REGION_LABELS[region] ?? region;
				return (
					<div key={region}>
						{grouped && (
							<h3 className="mb-2 text-sm font-semibold">
								{label}{" "}
								<span className="font-normal text-muted-foreground tabular-nums">
									· {offerCount(regionAlerts.length)}
								</span>
							</h3>
						)}
						<div className="grid gap-3 xl:grid-cols-2">
							{regionAlerts.map((alert) => (
								<AlertCard key={alert.id} alert={alert} mapKind={mapKind} />
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}

/**
 * Deep link to the offer on the map, pre-filtered to its source and kind.
 * The map schema has no per-listing focus param, so this narrows the feed to
 * the same segment and portal rather than pretending to center the pin.
 */
function mapSearchFor(
	alert: AlertDto,
	mapKind: NonNullable<ListingSearch["kind"]>,
): ListingSearch {
	return {
		source: alert.listing.source,
		kind: mapKind,
		offerType: "sale",
	};
}

function AlertCard({
	alert,
	mapKind,
}: {
	alert: AlertDto;
	mapKind: NonNullable<ListingSearch["kind"]>;
}) {
	const discount = alert.discountPct;
	const askingM2 =
		alert.listing.pricePerM2 ??
		(alert.listing.price != null &&
		alert.listing.areaM2 != null &&
		alert.listing.areaM2 > 0
			? alert.listing.price / alert.listing.areaM2
			: null);
	return (
		<Card className="gap-4 py-4">
			<CardHeader className="px-4">
				<CardDescription className="text-xs">
					#{alert.rank} · {REGION_LABELS[alert.region] ?? alert.region}
				</CardDescription>
				<CardTitle className="leading-snug">
					<a
						href={alert.listing.url}
						target="_blank"
						rel="noreferrer"
						aria-label={`Otwórz ofertę „${alert.listing.title}” w nowej karcie (${alert.listing.source})`}
						className="break-words rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						{alert.listing.title}
					</a>
				</CardTitle>
				<CardDescription className="break-words">
					{alert.listing.district ?? alert.listing.city ?? "brak dzielnicy"} ·{" "}
					{alert.listing.areaM2 != null
						? `${formatNumber(Math.round(alert.listing.areaM2))} m²`
						: "brak metrażu"}{" "}
					· {alert.listing.rooms ?? "?"} pok.
				</CardDescription>
				<CardAction className="text-right">
					<div className="text-2xl font-semibold tabular-nums">
						{alert.score.toFixed(1)}
					</div>
					<div className="text-xs text-muted-foreground">score</div>
				</CardAction>
			</CardHeader>

			<CardContent className="flex flex-col gap-3 px-4">
				<div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
					<Metric label="Cena" value={alert.listing.price} suffix=" zł" />
					<Metric label="Wycena" value={alert.fairPrice} suffix=" zł" />
					<Metric
						label="Poniżej mediany okolicy"
						value={discount}
						suffix="%"
						emphasis={(discount ?? 0) >= 10}
					/>
					<Metric label="Cena za m²" value={askingM2} suffix=" zł/m²" />
					<Metric label="Wycena za m²" value={alert.fairM2} suffix=" zł/m²" />
					<Metric
						label="Pewność"
						value={(alert.confidence ?? 0) * 100}
						suffix="%"
					/>
				</div>

				<div className="grid grid-cols-5 gap-1 text-center text-xs">
					<ScorePill label="Cena" value={alert.valueScore} />
					<ScorePill label="Transport" value={alert.transitScore} />
					<ScorePill label="Zieleń" value={alert.greenScore} />
					<ScorePill label="Nieruch." value={alert.propertyScore} />
					<ScorePill label="Ryzyko" value={alert.riskScore} />
				</div>

				<ul className="flex flex-col gap-1 text-sm">
					{alert.reasons.slice(0, 4).map((reason) => (
						<li
							key={reason.label}
							className={cn(
								reason.direction === "positive"
									? "text-emerald-400"
									: "text-red-400",
							)}
						>
							<span className="tabular-nums">
								{reason.direction === "positive" ? "+" : ""}
								{reason.impact.toFixed(1)}
							</span>{" "}
							· {reason.label}
						</li>
					))}
				</ul>

				{alert.flags.length > 0 && (
					<div className="flex flex-wrap gap-1">
						{alert.flags.map((flag) => (
							<Badge key={flag} variant="secondary">
								{flag}
							</Badge>
						))}
					</div>
				)}
			</CardContent>

			<CardFooter className="flex-wrap gap-x-4 gap-y-1 px-4">
				<Button variant="link" size="sm" className="h-auto p-0" asChild>
					<Link
						to="/map"
						search={mapSearchFor(alert, mapKind)}
						aria-label={`Pokaż ofertę „${alert.listing.title}” na mapie`}
					>
						<MapIcon aria-hidden="true" />
						Pokaż na mapie
					</Link>
				</Button>
				<Button variant="link" size="sm" className="h-auto p-0" asChild>
					<a
						href={alert.listing.url}
						target="_blank"
						rel="noreferrer"
						aria-label={`Otwórz ogłoszenie „${alert.listing.title}” w portalu ${alert.listing.source} (nowa karta)`}
					>
						Ogłoszenie w portalu
						<ExternalLink aria-hidden="true" />
					</a>
				</Button>
			</CardFooter>
		</Card>
	);
}

function Metric({
	label,
	value,
	suffix,
	emphasis = false,
}: {
	label: string;
	value: number | null;
	suffix: string;
	emphasis?: boolean;
}) {
	return (
		<div className={cn(emphasis && "text-emerald-400")}>
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="font-medium tabular-nums">
				{value == null
					? "—"
					: `${suffix === "%" ? formatDecimal(value) : formatNumber(Math.round(value))}${suffix}`}
			</div>
		</div>
	);
}

function ScorePill({ label, value }: { label: string; value: number }) {
	return (
		<Badge
			variant="secondary"
			className={cn(
				"h-auto w-full flex-col gap-0 rounded-md px-1 py-1",
				value >= 75
					? "text-emerald-400"
					: value < 50
						? "text-red-400"
						: undefined,
			)}
		>
			<span className="text-[10px] uppercase tracking-wide">{label}</span>
			<span className="font-semibold tabular-nums">{value}</span>
		</Badge>
	);
}

const decimal = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });

function formatDecimal(value: number): string {
	return decimal.format(value);
}
