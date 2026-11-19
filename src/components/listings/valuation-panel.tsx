import { Badge } from "#/components/ui/badge";
import { Card, CardContent } from "#/components/ui/card";
import { Separator } from "#/components/ui/separator";
import { useValuation } from "#/hooks/use-valuation";
import { formatNumber } from "#/lib/format";
import { cn } from "#/lib/utils";
import { horizonLabel } from "#/lib/valuation/upside";

/**
 * The valuation model reports its rating/upside tones as light-theme Tailwind
 * classes (`text-emerald-600`, `text-gray-700`, ...). Map them onto classes
 * that read on the dark surface without touching the shared valuation lib.
 */
const TONE_CLASS: Record<string, string> = {
	"text-emerald-600": "text-emerald-400",
	"text-emerald-700": "text-emerald-400",
	"text-gray-600": "text-muted-foreground",
	"text-gray-700": "text-foreground",
	"text-amber-600": "text-amber-400",
	"text-red-600": "text-red-400",
};

function toneClass(tone: string): string {
	return TONE_CLASS[tone] ?? tone;
}

/** Expanded-row valuation panel. The query only runs when the row opens. */
export function ValuationPanel({ id }: { id: number }) {
	const { data, isLoading } = useValuation(id);
	if (isLoading) {
		return (
			<div className="px-6 py-3 text-xs text-muted-foreground">
				Liczenie wyceny…
			</div>
		);
	}
	if (!data || !data.offer) {
		return (
			<div className="px-6 py-3 text-xs text-muted-foreground">
				Brak danych do wyceny.
			</div>
		);
	}
	const compRow = (
		label: string,
		value: { avgM2: number; n: number } | null,
	) =>
		value ? (
			<div className="flex justify-between">
				<span className="text-muted-foreground">{label}</span>
				<span>
					{formatNumber(Math.round(value.avgM2))} zł/m²
					<span className="text-muted-foreground/70"> ({value.n})</span>
				</span>
			</div>
		) : null;
	const qualityLabel = (quality: string) =>
		quality === "high" ? "wysoka" : quality === "medium" ? "średnia" : "niska";
	const pct = (value: number | null | undefined) =>
		value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
	const strategyBlock = (
		label: string,
		className: string,
		horizons:
			| Array<{
					years: number;
					irr: { p10: number; p50: number; p90: number } | null;
					probabilityLossPct: number;
			  }>
			| undefined,
		year1NetIncome: number | undefined,
	) => {
		if (!horizons || horizons.length === 0) return null;
		const final = horizons.find((horizon) => horizon.years === 5);
		return (
			<div>
				<div className={cn("font-medium", className)}>{label}</div>
				<div className="text-foreground/80">
					IRR{" "}
					{horizons
						.map(
							(horizon) =>
								`${horizon.years}l ${horizon.irr?.p50.toFixed(1) ?? "—"}%`,
						)
						.join(" · ")}
				</div>
				<div className="text-muted-foreground">
					80% (5 lat):{" "}
					{final?.irr ? `${pct(final.irr.p10)} … ${pct(final.irr.p90)}` : "—"} ·
					P(straty) {final ? `${final.probabilityLossPct.toFixed(1)}%` : "—"}
				</div>
				<div className="text-muted-foreground/70">
					dochód netto/rok:{" "}
					{year1NetIncome == null ? "—" : `${formatNumber(year1NetIncome)} zł`}
				</div>
			</div>
		);
	};
	return (
		<Card className="gap-2 rounded-none border-0 bg-transparent py-3 text-xs shadow-none">
			<CardContent className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">Wycena:</span>
					{data.estimate?.fairM2 != null && (
						<span>
							wartość godziwa <b>{formatNumber(data.estimate.fairM2)} zł/m²</b>
							{data.offer.pricePerM2 != null && (
								<span className="text-muted-foreground">
									{" "}
									(oferta {formatNumber(Math.round(data.offer.pricePerM2))})
								</span>
							)}
						</span>
					)}
					{data.estimate?.rating && (
						<Badge
							variant="outline"
							className={toneClass(data.estimate.rating.tone)}
						>
							{data.estimate.rating.label}
							{data.estimate.overUnderPct != null &&
								` ${data.estimate.overUnderPct > 0 ? "+" : ""}${data.estimate.overUnderPct}%`}
						</Badge>
					)}
					{data.buyPrice && (
						<span className="text-muted-foreground">
							ROI od ceny zakupu <b>{formatNumber(data.buyPrice.price)} zł</b>
							{data.buyPrice.source === "estimated" &&
								` (szacunek${data.buyPrice.fairM2 != null ? ` · ${formatNumber(data.buyPrice.fairM2)} zł/m²` : ""})`}
						</span>
					)}
				</div>
				{/* The whole market, independent of the comp set: it keeps a thin
				    or empty comp list from reading as "no price history". */}
				{data.marketMedian && (
					<div className="text-muted-foreground">
						Mediana rynku:{" "}
						<b className="text-foreground/90">
							{formatNumber(data.marketMedian.medianM2)} zł/m²
						</b>{" "}
						({formatNumber(data.marketMedian.p25M2)}–
						{formatNumber(data.marketMedian.p75M2)} · {data.marketMedian.sample}{" "}
						transakcji · {data.marketMedian.months} mies.
						{data.marketMedian.radiusM != null
							? ` · ${Math.round(data.marketMedian.radiusM / 1000)} km`
							: ""}
						)
					</div>
				)}
				<div className="flex flex-col gap-0.5">
					{compRow(
						"To samo budynku",
						data.estimate?.compSets.buildingRcn
							? {
									avgM2: data.estimate.compSets.buildingRcn.medianM2,
									n: data.estimate.compSets.buildingRcn.n,
								}
							: null,
					)}
					{compRow(
						"Okolica",
						data.estimate?.compSets.nearbyRcn
							? {
									avgM2: data.estimate.compSets.nearbyRcn.medianM2,
									n: data.estimate.compSets.nearbyRcn.n,
								}
							: null,
					)}
					{compRow(
						"Transakcje RCN (1 km, 24 mies.)",
						data.estimate?.compSets.listing
							? {
									avgM2: data.estimate.compSets.listing.medianM2,
									n: data.estimate.compSets.listing.n,
								}
							: null,
					)}
				</div>
				{data.estimate?.upside && (
					<>
						<Separator />
						<div className="flex flex-col gap-0.5">
							<div className="flex items-center justify-between">
								<span className="font-medium">
									Potencjał {horizonLabel(data.estimate.upside.horizonMonths)}:
								</span>
								<span className={toneClass(data.estimate.upside.tone)}>
									<b>{data.estimate.upside.score}/100</b> ·{" "}
									{data.estimate.upside.label}
								</span>
							</div>
							<div className="text-foreground/80">
								prognoza {formatNumber(data.estimate.upside.expectedFairM2)}{" "}
								zł/m² ({data.estimate.upside.expectedGrowthPct > 0 ? "+" : ""}
								{data.estimate.upside.expectedGrowthPct}%) · ryzyko −
								{data.estimate.upside.riskPenaltyPct} p.p. → skorygowane{" "}
								<b>
									{data.estimate.upside.riskAdjustedUpsidePct != null &&
									data.estimate.upside.riskAdjustedUpsidePct > 0
										? "+"
										: ""}
									{data.estimate.upside.riskAdjustedUpsidePct ?? "—"}%/rok
								</b>
							</div>
							<div className="text-muted-foreground/70">
								{data.estimate.upside.basis}
							</div>
							<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
								{data.estimate.upside.horizons.map((horizon) => (
									<span
										key={horizon.months}
										className={toneClass(horizon.tone)}
									>
										{horizonLabel(horizon.months)}:{" "}
										<b>
											{horizon.expectedUpsidePct > 0 ? "+" : ""}
											{horizon.expectedUpsidePct}%
										</b>
										<span className="text-muted-foreground/70">
											{" "}
											(p10 {horizon.p10UpsidePct}% · p90 {horizon.p90UpsidePct}
											%)
										</span>
										<span className="text-muted-foreground">
											{" "}
											· RA {horizon.riskAdjustedAnnualPct}%/rok
										</span>
									</span>
								))}
							</div>
						</div>
					</>
				)}
				<Separator />
				<div className="grid grid-cols-2 gap-2">
					{data.lt && (
						<div>
							<div className="font-medium text-emerald-400">
								Najem długoterminowy (netto)
							</div>
							<div className="text-foreground/80">
								{formatNumber(data.lt.rentAvg)} zł −{" "}
								{formatNumber(data.lt.czynszAvg)} opłaty =
								<b> {formatNumber(data.lt.netMonthly)} zł/mies.</b>
							</div>
							<div className="text-muted-foreground">
								rocznie netto {formatNumber(data.lt.netYearly)} zł · ROI{" "}
								<b>{data.lt.netYieldPct?.toFixed(1) ?? "—"}%</b> (
								{data.lt.basis}, {data.lt.n})
							</div>
						</div>
					)}
					{data.str && (
						<div>
							<div className="font-medium text-rose-400">
								Najem krótkoterminowy (netto, szac.)
							</div>
							<div className="text-foreground/80">
								{formatNumber(data.str.nightlyAvg)} zł/noc ×{" "}
								{(data.str.occupancy * 100).toFixed(0)}% obłożenia =
								<b> {formatNumber(data.str.netMonthly)} zł/mies.</b>
							</div>
							<div className="text-muted-foreground">
								rocznie netto {formatNumber(data.str.netYearly)} zł · ROI{" "}
								<b>{data.str.netYieldPct?.toFixed(1) ?? "—"}%</b> (
								{data.str.basis}, {data.str.n})
							</div>
						</div>
					)}
					{!data.lt && !data.str && (
						<div className="text-muted-foreground">
							Brak porównywalnych najmów w okolicy.
						</div>
					)}
				</div>
				{data.forecast && (
					<>
						<Separator />
						<div className="flex flex-col gap-1">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<span className="font-medium">Prognoza inwestycyjna</span>
								<span className="text-muted-foreground/70">
									jakość: ceny {qualityLabel(data.forecast.quality.price)} ·
									czynsz {qualityLabel(data.forecast.quality.rent)} · STR{" "}
									{qualityLabel(data.forecast.quality.str)}
								</span>
							</div>
							<div className="text-foreground/80">
								Ceny{" "}
								{data.forecast.appreciation
									.map(
										(horizon) =>
											`${horizon.years}l ${pct(horizon.meanPct)} (${pct(horizon.p10Pct)}…${pct(horizon.p90Pct)})`,
									)
									.join(" · ")}
							</div>
							<div className="grid grid-cols-2 gap-2">
								{strategyBlock(
									"Najem długoterminowy",
									"text-emerald-400",
									data.forecast.strategies.ltr?.horizons,
									data.forecast.strategies.ltr?.year1NetIncome,
								)}
								{strategyBlock(
									"Najem krótkoterminowy",
									"text-rose-400",
									data.forecast.strategies.str?.horizons,
									data.forecast.strategies.str?.year1NetIncome,
								)}
							</div>
							<details className="text-muted-foreground">
								<summary className="cursor-pointer">
									Założenia i jakość modeli
								</summary>
								<ul className="mt-1 list-disc pl-4 text-muted-foreground">
									{data.forecast.notes.map((note) => (
										<li key={note}>{note}</li>
									))}
								</ul>
							</details>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
