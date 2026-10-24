import type { PublicInvestmentFeature } from "#/hooks/use-public-investments";
import { formatNumber } from "#/lib/format";
import { categoryColor } from "#/lib/public-investments";

/**
 * "Inwestycje publiczne" as a table category on /listings: the same city
 * projects the map draws, rendered next to the offer table instead of as a
 * separate screen. They are not offers, so they never enter the price table
 * or the valuation flow.
 */
export function PublicInvestmentsTable({
	features,
	isLoading,
}: {
	features: readonly PublicInvestmentFeature[];
	isLoading: boolean;
}) {
	return (
		<div className="overflow-x-auto rounded border">
			<table className="w-full text-sm">
				<thead className="bg-gray-50 text-left">
					<tr>
						<th className="px-3 py-2">Kategoria</th>
						<th className="px-3 py-2">Projekt</th>
						<th className="px-3 py-2">Status</th>
						<th className="px-3 py-2 text-right">Rok</th>
						<th className="px-3 py-2">Miasto</th>
						<th className="px-3 py-2">Opis</th>
					</tr>
				</thead>
				<tbody>
					{isLoading && (
						<tr>
							<td colSpan={6} className="px-3 py-6 text-center text-gray-500">
								Ładowanie inwestycji...
							</td>
						</tr>
					)}
					{!isLoading &&
						features.map((feature) => {
							const row = feature.properties;
							return (
								<tr key={row.id} className="border-t">
									<td className="whitespace-nowrap px-3 py-1.5">
										<span className="inline-flex items-center gap-1.5">
											<span
												className="inline-block size-2 rounded-full"
												style={{ background: categoryColor(row.category) }}
											/>
											{row.categoryLabel}
										</span>
									</td>
									<td className="max-w-96 px-3 py-1.5">
										{row.url ? (
											<a
												href={row.url}
												target="_blank"
												rel="noreferrer"
												className="hover:text-blue-600 hover:underline"
											>
												{row.name}
											</a>
										) : (
											row.name
										)}
									</td>
									<td className="whitespace-nowrap px-3 py-1.5">
										{row.statusLabel}
									</td>
									<td className="px-3 py-1.5 text-right">
										{row.year == null ? "" : formatNumber(row.year)}
									</td>
									<td className="px-3 py-1.5">{row.city ?? ""}</td>
									<td className="max-w-96 px-3 py-1.5 text-gray-600">
										<div className="line-clamp-2">{row.description ?? ""}</div>
									</td>
								</tr>
							);
						})}
					{!isLoading && features.length === 0 && (
						<tr>
							<td colSpan={6} className="px-3 py-6 text-center text-gray-500">
								Brak inwestycji publicznych w bazie.
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
