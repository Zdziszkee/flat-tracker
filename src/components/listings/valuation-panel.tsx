import { useValuation } from "#/hooks/use-valuation";
import { formatNumber } from "#/lib/format";
import { horizonLabel } from "#/lib/valuation/upside";

/** Expanded-row valuation panel. The query only runs when the row opens. */
export function ValuationPanel({ id }: { id: number }) {
	const { data, isLoading } = useValuation(id);
	if (isLoading) {
		return (
			<div className="px-6 py-3 text-xs text-gray-500">Liczenie wyceny…</div>
		);
	}
	if (!data || !data.offer) {
		return (
			<div className="px-6 py-3 text-xs text-gray-500">
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
				<span className="text-gray-500">{label}</span>
				<span>
					{formatNumber(Math.round(value.avgM2))} zł/m²
					<span className="text-gray-400"> ({value.n})</span>
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
				<div className={`font-medium ${className}`}>{label}</div>
				<div className="text-gray-600">
					IRR{" "}
					{horizons
						.map(
							(horizon) =>
								`${horizon.years}l ${horizon.irr?.p50.toFixed(1) ?? "—"}%`,
						)
						.join(" · ")}
				</div>
				<div className="text-gray-500">
					80% (5 lat):{" "}
					{final?.irr ? `${pct(final.irr.p10)} … ${pct(final.irr.p90)}` : "—"} ·
					P(straty) {final ? `${final.probabilityLossPct.toFixed(1)}%` : "—"}
				</div>
				<div className="text-gray-400">
					dochód netto/rok:{" "}
					{year1NetIncome == null ? "—" : `${formatNumber(year1NetIncome)} zł`}
				</div>
			</div>
		);
	};
	return (
		<div className="space-y-2 bg-gray-50 px-6 py-3 text-xs">
			<div className="flex items-center gap-2">
				<span className="font-medium">Wycena:</span>
				{data.estimate?.fairM2 != null && (
					<span>
						wartość godziwa <b>{formatNumber(data.estimate.fairM2)} zł/m²</b>
						{data.offer.pricePerM2 != null && (
							<span className="text-gray-500">
								{" "}
								(oferta {formatNumber(Math.round(data.offer.pricePerM2))})
							</span>
						)}
					</span>
				)}
				{data.estimate?.rating && (
					<span
						className={`rounded px-1.5 py-0.5 font-medium ${data.estimate.rating.tone} bg-white`}
					>
						{data.estimate.rating.label}
						{data.estimate.overUnderPct != null &&
							` ${data.estimate.overUnderPct > 0 ? "+" : ""}${data.estimate.overUnderPct}%`}
					</span>
				)}
				{data.buyPrice && (
					<span className="text-gray-500">
						ROI od ceny zakupu <b>{formatNumber(data.buyPrice.price)} zł</b>
						{data.buyPrice.source === "estimated" &&
							` (szacunek${data.buyPrice.fairM2 != null ? ` · ${formatNumber(data.buyPrice.fairM2)} zł/m²` : ""})`}
					</span>
				)}
			</div>
			<div className="space-y-0.5">
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
				<div className="space-y-0.5 border-t pt-2">
					<div className="flex items-center justify-between">
						<span className="font-medium">Potencjał 12 mies.:</span>
						<span className={data.estimate.upside.tone}>
							<b>{data.estimate.upside.score}/100</b> ·{" "}
							{data.estimate.upside.label}
						</span>
					</div>
					<div className="text-gray-600">
						prognoza {formatNumber(data.estimate.upside.expectedFairM2)} zł/m² (
						{data.estimate.upside.expectedGrowthPct > 0 ? "+" : ""}
						{data.estimate.upside.expectedGrowthPct}%) · ryzyko −
						{data.estimate.upside.riskPenaltyPct} p.p. → skorygowane{" "}
						<b>
							{data.estimate.upside.riskAdjustedUpsidePct != null &&
							data.estimate.upside.riskAdjustedUpsidePct > 0
								? "+"
								: ""}
							{data.estimate.upside.riskAdjustedUpsidePct ?? "—"}%
						</b>
					</div>
					<div className="text-gray-400">{data.estimate.upside.basis}</div>
					<div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
						{data.estimate.upside.horizons.map((horizon) => (
							<span key={horizon.months} className={horizon.tone}>
								{horizonLabel(horizon.months)}:{" "}
								<b>
									{horizon.expectedUpsidePct > 0 ? "+" : ""}
									{horizon.expectedUpsidePct}%
								</b>
								<span className="text-gray-400">
									{" "}
									(p10 {horizon.p10UpsidePct}% · p90 {horizon.p90UpsidePct}%)
								</span>
								<span className="text-gray-500">
									{" "}
									· RA {horizon.riskAdjustedAnnualPct}%/rok
								</span>
							</span>
						))}
					</div>
				</div>
			)}
			<div className="grid grid-cols-2 gap-2 border-t pt-2">
				{data.lt && (
					<div>
						<div className="font-medium text-emerald-700">
							Najem długoterminowy (netto)
						</div>
						<div className="text-gray-600">
							{formatNumber(data.lt.rentAvg)} zł −{" "}
							{formatNumber(data.lt.czynszAvg)} opłaty =
							<b> {formatNumber(data.lt.netMonthly)} zł/mies.</b>
						</div>
						<div className="text-gray-500">
							rocznie netto {formatNumber(data.lt.netYearly)} zł · ROI{" "}
							<b>{data.lt.netYieldPct?.toFixed(1) ?? "—"}%</b> ({data.lt.basis},{" "}
							{data.lt.n})
						</div>
					</div>
				)}
				{data.str && (
					<div>
						<div className="font-medium text-rose-700">
							Najem krótkoterminowy (netto, szac.)
						</div>
						<div className="text-gray-600">
							{formatNumber(data.str.nightlyAvg)} zł/noc ×{" "}
							{(data.str.occupancy * 100).toFixed(0)}% obłożenia =
							<b> {formatNumber(data.str.netMonthly)} zł/mies.</b>
						</div>
						<div className="text-gray-500">
							rocznie netto {formatNumber(data.str.netYearly)} zł · ROI{" "}
							<b>{data.str.netYieldPct?.toFixed(1) ?? "—"}%</b> (
							{data.str.basis}, {data.str.n})
						</div>
					</div>
				)}
				{!data.lt && !data.str && (
					<div className="text-gray-500">
						Brak porównywalnych najmów w okolicy.
					</div>
				)}
			</div>
			{data.forecast && (
				<div className="space-y-1 border-t pt-2">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="font-medium">Prognoza inwestycyjna</span>
						<span className="text-gray-400">
							jakość: ceny {qualityLabel(data.forecast.quality.price)} · czynsz{" "}
							{qualityLabel(data.forecast.quality.rent)} · STR{" "}
							{qualityLabel(data.forecast.quality.str)}
						</span>
					</div>
					<div className="text-gray-600">
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
							"text-emerald-700",
							data.forecast.strategies.ltr?.horizons,
							data.forecast.strategies.ltr?.year1NetIncome,
						)}
						{strategyBlock(
							"Najem krótkoterminowy",
							"text-rose-700",
							data.forecast.strategies.str?.horizons,
							data.forecast.strategies.str?.year1NetIncome,
						)}
					</div>
					<details className="text-gray-500">
						<summary className="cursor-pointer">
							Założenia i jakość modeli
						</summary>
						<ul className="mt-1 list-disc pl-4 text-gray-500">
							{data.forecast.notes.map((note) => (
								<li key={note}>{note}</li>
							))}
						</ul>
					</details>
				</div>
			)}
		</div>
	);
}
