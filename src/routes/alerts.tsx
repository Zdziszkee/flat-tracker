import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ChevronDown,
	ExternalLink,
	Map as MapIcon,
	SearchX,
} from "lucide-react";
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
import type {
	AlertComparable,
	AlertDto,
	AlertProperties,
} from "#/types/alerts";

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
	{ segment: "plot", label: "Działki", mapKind: "plot" },
	{ segment: "house", label: "Domy z działką", mapKind: "house" },
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

const MARKET_LABELS: Record<string, string> = {
	primary: "pierwotny",
	secondary: "wtórny",
};

const AMENITY_LABELS: ReadonlyArray<{
	key: keyof Pick<
		AlertProperties,
		| "hasElevator"
		| "hasParking"
		| "hasGarage"
		| "hasBasement"
		| "hasBalcony"
		| "hasTerrace"
		| "hasGarden"
	>;
	label: string;
}> = [
	{ key: "hasElevator", label: "Winda" },
	{ key: "hasParking", label: "Parking" },
	{ key: "hasGarage", label: "Garaż" },
	{ key: "hasBasement", label: "Piwnica" },
	{ key: "hasBalcony", label: "Balkon" },
	{ key: "hasTerrace", label: "Taras" },
	{ key: "hasGarden", label: "Ogród" },
];

/** Raw portal values read fine once underscores become spaces. */
function humanizeToken(value: string): string {
	return value.replace(/_/g, " ").trim();
}

/**
 * Compact facts in a fixed order. Only values the portal actually published
 * appear, so a missing build year never renders as a placeholder.
 */
function factEntries(
	properties: AlertProperties,
	segment: string,
): Array<{ label: string; value: string }> {
	const isPlot = segment === "plot";
	// Every flat/house card states the building class and the heating, even when
	// the evidence is missing: "nie ustalono" is information a buyer needs, and
	// it is the difference between "a block" and "an old block" that decides
	// eligibility.
	const facts: Array<{ label: string; value: string | null }> = [
		{
			label: "Budynek",
			value: isPlot ? null : (properties.buildingClass ?? "nie ustalono"),
		},
		{
			label: "Ogrzewanie",
			value: isPlot
				? null
				: (properties.heatingLabel ??
					(properties.heatingType != null
						? humanizeToken(properties.heatingType)
						: "nie potwierdzone")),
		},
		{ label: "Rok budowy", value: properties.buildYear?.toString() ?? null },
		{
			label: "Materiał",
			value:
				properties.buildingMaterial != null
					? humanizeToken(properties.buildingMaterial)
					: null,
		},
		{
			label: "Kondygnacje",
			value: properties.floorCount?.toString() ?? null,
		},
		{
			label: "Rynek",
			value:
				properties.market != null
					? (MARKET_LABELS[properties.market] ??
						humanizeToken(properties.market))
					: null,
		},
		{
			label: "Stan",
			value:
				properties.condition != null
					? humanizeToken(properties.condition)
					: null,
		},
		{
			label: "Własność",
			value:
				properties.ownership != null
					? humanizeToken(properties.ownership)
					: null,
		},
		{
			label: "Działka",
			value:
				properties.plotAreaM2 != null
					? `${formatNumber(Math.round(properties.plotAreaM2))} m²`
					: null,
		},
	];
	return facts.filter(
		(fact): fact is { label: string; value: string } => fact.value != null,
	);
}

function amenityLabels(properties: AlertProperties): string[] {
	return AMENITY_LABELS.filter(({ key }) => properties[key]).map(
		({ label }) => label,
	);
}

interface NearestFeature {
	label: string;
	name: string;
	distanceM: number;
}

/**
 * Named nearby features. A distance without a name is not shown: the score
 * payload of older rows carries no names, and inventing one would mislead.
 */
function nearestFeatures(amenities: AlertDto["amenities"]): NearestFeature[] {
	if (!amenities) return [];
	const features: NearestFeature[] = [];
	const push = (
		label: string,
		name: string | null | undefined,
		distance: number | null | undefined,
	) => {
		if (name && distance != null) {
			features.push({ label, name, distanceM: distance });
		}
	};
	push("Park", amenities.parkName, amenities.parkM);
	push("Las", amenities.forestName, amenities.forestM);
	push("Woda", amenities.waterName, amenities.waterM);
	if (!features.some((feature) => feature.label === "Woda")) {
		push("Woda", amenities.riverName, amenities.riverM);
	}
	push("Dworzec", amenities.stationName, amenities.trainStationM);
	if (amenities.transitName && amenities.transitM != null) {
		push("Przystanek", amenities.transitName, amenities.transitM);
	} else if (amenities.tramName && amenities.tramM != null) {
		push("Przystanek", amenities.tramName, amenities.tramM);
	} else {
		push("Przystanek", amenities.busName, amenities.busM);
	}
	return features;
}

const kilometers = new Intl.NumberFormat("pl-PL", {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1,
});

/** `350 m` below a kilometre, then `1,4 km` with a Polish decimal comma. */
function formatDistance(distanceM: number): string {
	if (distanceM < 1000) return `${Math.round(distanceM)} m`;
	return `${kilometers.format(distanceM / 1000)} km`;
}

/** The comparable sample behind the median, when the valuation had one. */
function comparableNote(alert: AlertDto): string | null {
	if (alert.compCount <= 0) return null;
	const rcn =
		alert.compRcnCount > 0 ? `, w tym ${alert.compRcnCount} z RCN` : "";
	return `Wycena z ${offerCount(alert.compCount)}${rcn}`;
}

const factorFormat = new Intl.NumberFormat("pl-PL", {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

/** `MM.YYYY` from a stored ISO date; "brak daty" when the comp carried none. */
function comparableMonth(date: string | null): string {
	if (date == null) return "brak daty";
	const match = /^(\d{4})-(\d{2})/.exec(date);
	if (match) return `${match[2]}.${match[1]}`;
	const parsed = new Date(date);
	if (Number.isNaN(parsed.getTime())) return "brak daty";
	return `${String(parsed.getMonth() + 1).padStart(2, "0")}.${parsed.getFullYear()}`;
}

/**
 * One comparable, in the order a buyer checks it: what it was, where, how big,
 * at what price, how the correction moved that price, and when it sold.
 */
function ComparableItem({ comparable }: { comparable: AlertComparable }) {
	const size =
		comparable.areaM2 != null
			? `${formatNumber(Math.round(comparable.areaM2))} m²`
			: null;
	const delta = comparable.adjustedPriceM2 - comparable.priceM2;
	const corrected =
		comparable.priceM2 > 0 && Math.abs(delta) / comparable.priceM2 > 0.01;
	// RCN comps are indexed forward; listing comps are converted from asking
	// to transaction price first, so the factor names the correction applied.
	const factor =
		comparable.source === "rcn" || comparable.askingRatio == null
			? `indeks ×${factorFormat.format(comparable.timeFactor)}`
			: `oferta ×${factorFormat.format(comparable.askingRatio)}`;
	return (
		<li className="border-l pl-2">
			<span className="block text-foreground">
				{comparable.source === "rcn" ? "RCN" : "oferta"}
				{comparable.address != null && ` · ${comparable.address}`}
				{size != null && ` · ${size}`}
			</span>
			<span className="block tabular-nums">
				{formatNumber(Math.round(comparable.priceM2))} zł/m²
				{corrected && (
					<>
						{` → ${formatNumber(Math.round(comparable.adjustedPriceM2))} zł/m² `}
						<span className="text-muted-foreground">({factor})</span>
					</>
				)}
				{` · ${comparableMonth(comparable.date)}`}
				{comparable.distanceM != null &&
					` · ${formatDistance(comparable.distanceM)}`}
			</span>
		</li>
	);
}

/**
 * "Wycena z N ofert" as a disclosure. The summary keeps the compact line; the
 * button expands the comparable sample stored with the score. A row scored
 * before comparables were stored keeps the plain line it always had.
 */
function ComparablesDisclosure({ alert }: { alert: AlertDto }) {
	const [open, setOpen] = useState(false);
	const summary = comparableNote(alert);
	const comparables = alert.valuation?.comparables ?? [];
	if (summary == null) return null;
	if (comparables.length === 0) {
		return <p className="text-xs text-muted-foreground">{summary}</p>;
	}
	const listId = `comps-${alert.id}`;
	return (
		<div className="text-xs text-muted-foreground">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen((value) => !value)}
				className="flex min-h-11 w-full items-center gap-1.5 rounded text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-3.5 shrink-0 transition-transform",
						open && "rotate-180",
					)}
				/>
				<span>{summary}</span>
			</button>
			<ul
				id={listId}
				hidden={!open}
				aria-label="Oferty porównawcze do wyceny"
				className={cn(
					"mt-1 max-h-56 flex-col gap-1.5 overflow-y-auto pr-1",
					open ? "flex" : "hidden",
				)}
			>
				{comparables.map((comparable) => (
					<ComparableItem
						key={`${comparable.source}-${comparable.id}`}
						comparable={comparable}
					/>
				))}
			</ul>
			{open && comparables.length < alert.compCount && (
				<p className="mt-1">
					Pokazano {comparables.length} z {alert.compCount} porównań.
				</p>
			)}
		</div>
	);
}

/**
 * House solitude and rental-market evidence stored with the score. Only the
 * values that were measured appear, and a house without any keeps no line.
 */
function houseExtrasLine(alert: AlertDto): string | null {
	if (alert.segment !== "house") return null;
	const { neighbourM, neighbours150m, strNightly, strSample } = alert.facts;
	const parts: string[] = [];
	if (neighbourM != null) {
		parts.push(`najbliższy budynek ${formatDistance(neighbourM)}`);
	}
	if (neighbours150m != null) {
		parts.push(`budynki w 150 m: ${formatNumber(neighbours150m)}`);
	}
	if (strNightly != null) {
		const sample = strSample != null ? ` (${offerCount(strSample)})` : "";
		parts.push(
			`Airbnb ~${formatNumber(Math.round(strNightly))} zł/noc${sample}`,
		);
	}
	return parts.length > 0 ? `Samotnie: ${parts.join(" · ")}` : null;
}

/** Risk codes the extractor emits, rendered as short Polish labels. */
const RISK_LABELS: Record<string, string> = {
	damp: "zawilgocenie",
	no_lift: "brak windy",
	roof_to_renovation: "dach do remontu",
	media_missing: "brak mediów",
	no_access: "brak dojazdu",
	flood_risk: "zagrożenie powodziowe",
	noise: "hałas",
	tenanted: "wynajęte",
	mortgage: "hipoteka",
	easement: "służebność",
	claims: "roszczenia",
	life_estate: "dożywocie",
};

function riskLabel(code: string): string {
	return RISK_LABELS[code] ?? humanizeToken(code);
}

/**
 * Why the offer is on the list: the fast-rail station (plots and houses) or
 * the centre-zone anchor (flats). A distance without a station name is never
 * shown, because the payload always carries the name when it carries a match.
 */
function locationEntries(
	alert: AlertDto,
): Array<{ label: string; value: string }> {
	const out: Array<{ label: string; value: string }> = [];
	const rail = alert.location?.fastRail;
	if (rail) {
		out.push({
			label: rail.kdpPlanned ? "KDP (plan)" : "Kolej 200+",
			value: `${rail.name} · ${formatDistance(rail.distanceM)}`,
		});
	}
	const zone = alert.location?.centreZone;
	if (zone) {
		out.push({
			label: "Centrum",
			value: `${zone.name} · ${formatDistance(zone.distanceM)}`,
		});
	}
	return out;
}

/**
 * The correction line: what moved the comparable median, and how the comps
 * were brought to today. Values are the ones stored with the score, so an old
 * alert shows the evidence of the version that raised it.
 */
function valuationNote(alert: AlertDto): string | null {
	const valuation = alert.valuation;
	if (!valuation) return null;
	const parts: string[] = [];
	if (valuation.qualityKnown && Math.abs(valuation.qualityPct) >= 0.5) {
		const sign = valuation.qualityPct > 0 ? "+" : "";
		const top = valuation.qualityReasons
			.slice()
			.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
			.slice(0, 2)
			.map((reason) => reason.label)
			.join(", ");
		parts.push(
			`korekta stanu ${sign}${valuation.qualityPct.toFixed(1)}%${top ? ` (${top})` : ""}`,
		);
	}
	if (valuation.timeFactorMedian != null && valuation.indexSpan) {
		parts.push(
			`indeks ${valuation.indexSpan.from} → ${valuation.indexSpan.to} ×${valuation.timeFactorMedian.toFixed(2)}`,
		);
	}
	if (
		valuation.askingRatio != null &&
		valuation.askingRatioSource === "fallback"
	) {
		parts.push(`komp. z ofert ×${valuation.askingRatio.toFixed(2)}`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Fresh arrivals lead their region group; rank order decides inside each
 * part, so the standing top-5% list keeps its original ordering.
 */
function sortFreshFirst(alerts: AlertDto[]): AlertDto[] {
	return [...alerts].sort(
		(a, b) => Number(b.isFresh) - Number(a.isFresh) || a.rank - b.rank,
	);
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
						Top 25 ofert na sprzedaż w trzech segmentach: mieszkania, działki i
						domy. Co najmniej 10% taniej od mediany podobnych z okolicy, osobno
						dla każdego segmentu. Mieszkania: bez wielkiej płyty i tylko z
						ogrzewaniem miejskim. Działki: tylko budowlane. Nowe oferty są
						oceniane po każdym odświeżeniu danych.
					</p>
					<p className="mt-1 text-sm text-muted-foreground">
						Data alertów:{" "}
						<span className="font-medium text-foreground tabular-nums">
							{data?.date ?? "…"}
						</span>{" "}
						· nowe w ostatnich 24 h:{" "}
						<span className="font-medium text-foreground tabular-nums">
							{data?.freshCount ?? 0}
						</span>
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

			<div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2 lg:grid-cols-3">
				{SECTIONS.map(({ segment, label, mapKind }) => {
					const alerts = sortFreshFirst(bySegment.get(segment) ?? []);
					return (
						<section
							key={segment}
							aria-labelledby={`section-${segment}`}
							className="min-w-0"
						>
							<h2
								id={`section-${segment}`}
								className="mb-2 text-lg font-semibold"
							>
								{label}{" "}
								<span className="text-sm font-normal text-muted-foreground tabular-nums">
									· top 25 · {offerCount(alerts.length)}
								</span>
							</h2>
							{isLoading ? (
								<div className="flex flex-col gap-3">
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
				const regionAlerts = sortFreshFirst(byRegion.get(region) ?? []);
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
						<div className="flex flex-col gap-3">
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
	const facts = factEntries(alert.properties, alert.segment);
	const amenities = amenityLabels(alert.properties);
	const nearby = nearestFeatures(alert.amenities);
	const extras = houseExtrasLine(alert);
	const location = locationEntries(alert);
	const correction = valuationNote(alert);
	return (
		<Card className="gap-4 py-4">
			<CardHeader className="px-4">
				<CardDescription className="flex flex-wrap items-center gap-2 text-xs">
					<span>
						#{alert.rank} · {REGION_LABELS[alert.region] ?? alert.region}
					</span>
					{alert.isFresh && (
						<Badge className="px-1.5 py-0 text-[10px] uppercase tracking-wide">
							Nowa (24h)
						</Badge>
					)}
					{alert.fallbackReason != null && (
						<Badge
							variant="outline"
							className="px-1.5 py-0 text-[10px] uppercase tracking-wide"
						>
							{alert.fallbackReason === "heating"
								? "Ogrzewanie niepotwierdzone"
								: "Możliwość zabudowy niepotwierdzona"}
						</Badge>
					)}
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

				{location.length > 0 && (
					<dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
						{location.map((entry) => (
							<div
								key={entry.label}
								className="flex items-baseline gap-1 whitespace-nowrap"
							>
								<dt className="text-muted-foreground">{entry.label}</dt>
								<dd className="font-medium">{entry.value}</dd>
							</div>
						))}
					</dl>
				)}

				{facts.length > 0 && (
					<dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
						{facts.map((fact) => (
							<div
								key={fact.label}
								className="flex items-baseline gap-1 whitespace-nowrap"
							>
								<dt className="text-muted-foreground">{fact.label}</dt>
								<dd className="font-medium">{fact.value}</dd>
							</div>
						))}
					</dl>
				)}

				{amenities.length > 0 && (
					<ul className="flex flex-wrap gap-1">
						{amenities.map((label) => (
							<li key={label}>
								<Badge variant="outline" className="text-[10px]">
									{label}
								</Badge>
							</li>
						))}
					</ul>
				)}

				{nearby.length > 0 && (
					<ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
						{nearby.map((feature) => (
							<li key={feature.label} className="whitespace-nowrap">
								<span>{feature.label}:</span>{" "}
								<span className="text-foreground">{feature.name}</span>{" "}
								<span className="tabular-nums">
									({formatDistance(feature.distanceM)})
								</span>
							</li>
						))}
					</ul>
				)}

				{extras != null && (
					<p className="text-xs text-muted-foreground">{extras}</p>
				)}

				<ComparablesDisclosure alert={alert} />

				{alert.facts.setting.length > 0 && (
					<p className="text-xs text-muted-foreground">
						Otoczenie: {alert.facts.setting.join(", ")}
					</p>
				)}

				{alert.facts.risks.length > 0 && (
					<p className="text-xs text-destructive">
						Ryzyka: {alert.facts.risks.map(riskLabel).join(", ")}
					</p>
				)}

				{correction && (
					<p className="text-xs text-muted-foreground">{correction}</p>
				)}

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
