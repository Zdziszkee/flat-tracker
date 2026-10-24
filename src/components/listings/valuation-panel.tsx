import { useValuation } from "#/hooks/use-valuation";
import { formatNumber } from "#/lib/format";

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
		</div>
	);
}
