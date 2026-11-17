import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { useAlerts } from "#/hooks/use-alerts";
import { formatNumber } from "#/lib/format";
import type { AlertSegment } from "#/lib/scoring/config";
import type { AlertDto } from "#/types/alerts";

export const Route = createFileRoute("/alerts")({
	component: AlertsPage,
});

const REGION_LABELS: Record<string, string> = {
	malopolskie: "Małopolska",
	slaskie: "Śląsk",
};

/** The three sections are always rendered, in this order, even when empty. */
const SECTIONS: ReadonlyArray<{ segment: AlertSegment; label: string }> = [
	{ segment: "flat", label: "Mieszkania" },
	{ segment: "house", label: "Domy z działką" },
	{ segment: "plot", label: "Działki" },
];

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
					<h1 className="text-xl font-semibold">Alerty dnia</h1>
					<p className="text-sm text-gray-600">
						Top 5% ofert na sprzedaż w trzech segmentach: mieszkania, domy i
						działki. Co najmniej 10% taniej od mediany podobnych z okolicy,
						osobno dla regionu i segmentu. Nowe oferty są oceniane po każdym
						odświeżeniu danych. Data: {data?.date ?? "..."}
					</p>
				</div>
				<div className="flex flex-wrap items-end gap-3">
					<label className="text-sm">
						<span className="mb-1 block text-gray-600">Region</span>
						<select
							className="rounded border px-2 py-1"
							value={region}
							onChange={(event) => setRegion(event.target.value)}
						>
							<option value="all">Wszystkie</option>
							<option value="malopolskie">Małopolska</option>
							<option value="slaskie">Śląsk</option>
						</select>
					</label>
					<Link to="/" className="text-blue-600 underline">
						Start
					</Link>
					<Link to="/listings" className="text-blue-600 underline">
						Ogłoszenia
					</Link>
				</div>
			</div>

			{isLoading && <p className="text-gray-500">Ładowanie alertów...</p>}

			<div className="space-y-8">
				{SECTIONS.map(({ segment, label }) => {
					const alerts = bySegment.get(segment) ?? [];
					return (
						<section key={segment}>
							<h2 className="mb-2 text-lg font-semibold">
								{label}{" "}
								<span className="text-sm font-normal text-gray-500">
									· top 5% · {alerts.length}{" "}
									{alerts.length === 1 ? "oferta" : "ofert"}
								</span>
							</h2>
							{alerts.length === 0 ? (
								<p className="rounded border border-dashed p-6 text-sm text-gray-500">
									{isLoading
										? "Ładowanie..."
										: "Brak ofert spełniających progi w tym segmencie. Lista uzupełnia się automatycznie po każdym odświeżeniu danych."}
								</p>
							) : (
								<div className="grid gap-3 xl:grid-cols-2">
									{alerts.map((alert) => (
										<AlertCard key={alert.id} alert={alert} />
									))}
								</div>
							)}
						</section>
					);
				})}
			</div>
		</div>
	);
}

function AlertCard({ alert }: { alert: AlertDto }) {
	const discount = alert.discountPct;
	return (
		<article className="rounded border bg-white p-4 shadow-sm">
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="text-xs text-gray-500">
						#{alert.rank} · {REGION_LABELS[alert.region] ?? alert.region}
					</div>
					<a
						href={alert.listing.url}
						target="_blank"
						rel="noreferrer"
						className="font-medium hover:text-blue-600 hover:underline"
					>
						{alert.listing.title}
					</a>
					<div className="mt-1 text-sm text-gray-600">
						{alert.listing.district ?? alert.listing.city ?? "brak dzielnicy"} ·{" "}
						{alert.listing.areaM2 != null
							? `${formatNumber(Math.round(alert.listing.areaM2))} m²`
							: "brak metrażu"}{" "}
						· {alert.listing.rooms ?? "?"} pok.
					</div>
				</div>
				<div className="text-right">
					<div className="text-2xl font-semibold">{alert.score.toFixed(1)}</div>
					<div className="text-xs text-gray-500">score</div>
				</div>
			</div>

			<div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
				<Metric label="Cena" value={alert.listing.price} suffix=" zł" />
				<Metric label="Wycena" value={alert.fairPrice} suffix=" zł" />
				<Metric
					label="Poniżej mediany okolicy"
					value={discount}
					suffix="%"
					emphasis={(discount ?? 0) >= 10}
				/>
				<Metric
					label="Pewność"
					value={(alert.confidence ?? 0) * 100}
					suffix="%"
				/>
			</div>

			<div className="mt-3 grid grid-cols-5 gap-1 text-center text-xs">
				<ScorePill label="Cena" value={alert.valueScore} />
				<ScorePill label="Transport" value={alert.transitScore} />
				<ScorePill label="Zieleń" value={alert.greenScore} />
				<ScorePill label="Nieruch." value={alert.propertyScore} />
				<ScorePill label="Ryzyko" value={alert.riskScore} />
			</div>

			<ul className="mt-3 space-y-1 text-sm">
				{alert.reasons.slice(0, 4).map((reason) => (
					<li
						key={reason.label}
						className={
							reason.direction === "positive"
								? "text-emerald-700"
								: "text-red-700"
						}
					>
						{reason.direction === "positive" ? "+" : ""}
						{reason.impact.toFixed(1)} · {reason.label}
					</li>
				))}
			</ul>

			{alert.flags.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-1">
					{alert.flags.map((flag) => (
						<span
							key={flag}
							className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
						>
							{flag}
						</span>
					))}
				</div>
			)}
		</article>
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
		<div className={emphasis ? "text-emerald-700" : ""}>
			<div className="text-xs text-gray-500">{label}</div>
			<div className="font-medium">
				{value == null
					? "—"
					: `${suffix === "%" ? formatDecimal(value) : formatNumber(Math.round(value))}${suffix}`}
			</div>
		</div>
	);
}

function ScorePill({ label, value }: { label: string; value: number }) {
	const tone =
		value >= 75
			? "bg-emerald-50 text-emerald-800"
			: value >= 50
				? "bg-gray-50 text-gray-700"
				: "bg-red-50 text-red-800";
	return (
		<div className={`rounded px-1 py-1 ${tone}`}>
			<div className="text-[10px] uppercase tracking-wide">{label}</div>
			<div className="font-semibold">{value}</div>
		</div>
	);
}

const decimal = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 1 });

function formatDecimal(value: number): string {
	return decimal.format(value);
}
