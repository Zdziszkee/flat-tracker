import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
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
		<div className="rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="px-3">Kategoria</TableHead>
						<TableHead className="px-3">Projekt</TableHead>
						<TableHead className="px-3">Status</TableHead>
						<TableHead className="px-3 text-right">Rok</TableHead>
						<TableHead className="px-3">Miasto</TableHead>
						<TableHead className="px-3">Opis</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{isLoading && (
						<TableRow className="hover:bg-transparent">
							<TableCell
								colSpan={6}
								className="px-3 py-6 text-center text-muted-foreground"
							>
								Ładowanie inwestycji...
							</TableCell>
						</TableRow>
					)}
					{!isLoading &&
						features.map((feature) => {
							const row = feature.properties;
							return (
								<TableRow key={row.id}>
									<TableCell className="px-3 py-1.5">
										<span className="inline-flex items-center gap-1.5">
											<span
												className="inline-block size-2 rounded-full"
												style={{ background: categoryColor(row.category) }}
											/>
											{row.categoryLabel}
										</span>
									</TableCell>
									<TableCell className="max-w-96 px-3 py-1.5">
										{row.url ? (
											<a
												href={row.url}
												target="_blank"
												rel="noreferrer"
												className="hover:underline"
											>
												{row.name}
											</a>
										) : (
											row.name
										)}
									</TableCell>
									<TableCell className="px-3 py-1.5">
										{row.statusLabel}
									</TableCell>
									<TableCell className="px-3 py-1.5 text-right">
										{row.year == null ? "" : formatNumber(row.year)}
									</TableCell>
									<TableCell className="px-3 py-1.5">
										{row.city ?? ""}
									</TableCell>
									<TableCell className="max-w-96 px-3 py-1.5 whitespace-normal text-muted-foreground">
										<div className="line-clamp-2">{row.description ?? ""}</div>
									</TableCell>
								</TableRow>
							);
						})}
					{!isLoading && features.length === 0 && (
						<TableRow className="hover:bg-transparent">
							<TableCell
								colSpan={6}
								className="px-3 py-6 text-center text-muted-foreground"
							>
								Brak inwestycji publicznych w bazie.
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</div>
	);
}
