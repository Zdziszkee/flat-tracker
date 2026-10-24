import { Label } from "#/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type {
	ListingFilters as Filters,
	ListingFacets,
} from "#/lib/listing-features";
import { DAY_OPTIONS, PUBLIC_INVESTMENTS_KIND } from "#/lib/listing-features";
import { PROPERTY_KIND_LABELS, type PropertyKind } from "#/lib/property-kind";
import { SOURCE_COLORS, sourceLabel } from "#/lib/sources";

interface ListingFiltersProps {
	value: Filters;
	sources: readonly string[];
	facets: ListingFacets;
	showOfferType?: boolean;
	/** Optional count for the separate "Inwestycje publiczne" category. */
	publicInvestmentsCount?: number;
	onChange: (next: Filters) => void;
}

/**
 * One filter bar for `/map` and `/listings`. Both routes keep the state in
 * the URL, so a filtered view is linkable and the back button works.
 */
export function ListingFilters({
	value,
	sources,
	facets,
	showOfferType = false,
	publicInvestmentsCount,
	onChange,
}: ListingFiltersProps) {
	return (
		<div className="flex flex-wrap items-end gap-3 text-sm">
			<div className="flex flex-col gap-1">
				<Label className="text-xs text-gray-500">Źródło</Label>
				<Select
					value={value.source}
					onValueChange={(source) => onChange({ ...value, source })}
				>
					<SelectTrigger className="w-[190px]" aria-label="Źródło">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">Wszystkie ({facets.total})</SelectItem>
						{sources.map((source) => (
							<SelectItem key={source} value={source}>
								<span
									className="mr-2 inline-block size-2.5 shrink-0 rounded-full ring-1 ring-black/10"
									style={{
										backgroundColor:
											SOURCE_COLORS[source as keyof typeof SOURCE_COLORS] ??
											"#94a3b8",
									}}
								/>
								{sourceLabel(source)} ({facets.bySource.get(source) ?? 0})
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			<div className="flex flex-col gap-1">
				<Label className="text-xs text-gray-500">Rodzaj</Label>
				<Select
					value={value.kind}
					onValueChange={(kind) =>
						onChange({ ...value, kind: kind as Filters["kind"] })
					}
				>
					<SelectTrigger
						className="w-[150px]"
						aria-label="Rodzaj nieruchomości"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">Wszystkie ({facets.total})</SelectItem>
						{(Object.keys(PROPERTY_KIND_LABELS) as Array<PropertyKind | "all">)
							.filter((kind): kind is PropertyKind => kind !== "all")
							.map((kind) => (
								<SelectItem key={kind} value={kind}>
									{PROPERTY_KIND_LABELS[kind]} ({facets.byKind.get(kind) ?? 0})
								</SelectItem>
							))}
						<SelectItem value={PUBLIC_INVESTMENTS_KIND}>
							Inwestycje publiczne
							{publicInvestmentsCount != null
								? ` (${publicInvestmentsCount})`
								: ""}
						</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="flex flex-col gap-1">
				<Label className="text-xs text-gray-500">Data dodania</Label>
				<Select
					value={String(value.days)}
					onValueChange={(days) =>
						onChange({ ...value, days: Number(days) as Filters["days"] })
					}
				>
					<SelectTrigger className="w-[160px]" aria-label="Data dodania">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{DAY_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={String(option.value)}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{showOfferType && (
				<div className="flex flex-col gap-1">
					<Label className="text-xs text-gray-500">Typ</Label>
					<Select
						value={value.offerType}
						onValueChange={(offerType) =>
							onChange({
								...value,
								offerType: offerType as Filters["offerType"],
							})
						}
					>
						<SelectTrigger className="w-[150px]" aria-label="Typ oferty">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">Wszystkie typy</SelectItem>
							<SelectItem value="sale">Sprzedaż</SelectItem>
							<SelectItem value="rental">Najem</SelectItem>
						</SelectContent>
					</Select>
				</div>
			)}
		</div>
	);
}
