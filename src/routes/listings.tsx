import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { ListingFilters } from "#/components/listing-filters";
import { BudujesieThreadPanel } from "#/components/listings/budujesie-thread-panel";
import { ValuationPanel } from "#/components/listings/valuation-panel";
import { useListingFilters } from "#/hooks/use-listing-filters";
import { useListings } from "#/hooks/use-listings";
import { useSources } from "#/hooks/use-sources";
import { formatDate, formatNumber, realizationCaption } from "#/lib/format";
import {
	filterListings,
	listingFacets,
	listingSearchSchema,
	searchFromFilters,
} from "#/lib/listing-features";
import { sourceLabel } from "#/lib/sources";

export const Route = createFileRoute("/listings")({
	validateSearch: (search) => listingSearchSchema.parse(search),
	component: ListingsPage,
});

function ListingsPage() {
	const { filters, setFilters } = useListingFilters("/listings");
	const [expanded, setExpanded] = useState<number | null>(null);
	const { data, isLoading } = useListings();
	const { data: sources } = useSources();
	const sourceOptions = sources?.sources ?? ["otodom", "olx"];

	const allRows = data?.listings ?? [];
	const facets = listingFacets(allRows, filters.days);
	const rows = filterListings(allRows, filters);

	return (
		<div className="p-6">
			<div className="mb-4 flex flex-wrap items-end justify-between gap-3">
				<h1 className="text-xl font-semibold">
					Ogłoszenia · Małopolska i Śląsk
				</h1>
				<div className="flex items-end gap-3">
					<ListingFilters
						value={filters}
						sources={sourceOptions}
						facets={facets}
						onChange={setFilters}
					/>
					<Link
						to="/map"
						search={searchFromFilters(filters)}
						className="text-blue-600 underline"
					>
						Mapa
					</Link>
					<Link to="/sources" className="text-blue-600 underline">
						Data sources
					</Link>
				</div>
			</div>

			<div className="overflow-x-auto rounded border">
				<table className="w-full text-sm">
					<thead className="bg-gray-50 text-left">
						<tr>
							<th className="px-3 py-2">Źródło</th>
							<th className="px-3 py-2">Tytuł</th>
							<th className="px-3 py-2 text-right">Cena</th>
							<th className="px-3 py-2 text-right">zł/m²</th>
							<th className="px-3 py-2 text-right">m²</th>
							<th className="px-3 py-2 text-right">Pokoje</th>
							<th className="px-3 py-2">Dzielnica</th>
							<th className="px-3 py-2">Data dodania</th>
							<th className="px-2 py-2" aria-label="wycena" />
						</tr>
					</thead>
					<tbody>
						{isLoading && (
							<tr>
								<td colSpan={9} className="px-3 py-6 text-center text-gray-500">
									Ładowanie...
								</td>
							</tr>
						)}
						{!isLoading &&
							rows.map((row) => {
								const expandable =
									row.offerType === "sale" ||
									row.offerType === "long_term_rental" ||
									row.source === "budujesie";
								return (
									<Fragment key={`${row.source}-${row.id}`}>
										<tr
											className={`border-t ${expandable ? "cursor-pointer hover:bg-gray-50" : ""}`}
											onClick={() => {
												if (!expandable) return;
												setExpanded(expanded === row.id ? null : row.id);
											}}
										>
											<td className="px-3 py-1.5">
												<span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
													{sourceLabel(row.source)}
												</span>
											</td>
											<td className="max-w-96 px-3 py-1.5">
												<div className="truncate">
													<a
														href={row.url}
														target="_blank"
														rel="noreferrer"
														className="hover:text-blue-600 hover:underline"
													>
														{row.title}
													</a>
												</div>
												{row.constructionEndLabel && (
													<div className="truncate text-xs text-amber-700">
														{realizationCaption(
															row.constructionEndLabel,
															row.constructionEndDate,
														)}
													</div>
												)}
											</td>
											<td className="px-3 py-1.5 text-right font-medium">
												{formatNumber(row.price)}
											</td>
											<td className="px-3 py-1.5 text-right">
												{formatNumber(row.pricePerM2)}
											</td>
											<td className="px-3 py-1.5 text-right">
												{formatNumber(row.areaM2)}
											</td>
											<td className="px-3 py-1.5 text-right">
												{row.rooms ?? ""}
											</td>
											<td className="px-3 py-1.5">{row.district ?? ""}</td>
											<td className="px-3 py-1.5 text-gray-500">
												{formatDate(row.listedAt ?? row.firstSeenAt)}
											</td>
											<td className="px-2 py-1.5 text-center text-gray-400">
												{expandable ? (expanded === row.id ? "▾" : "▸") : ""}
											</td>
										</tr>
										{expanded === row.id && (
											<tr>
												<td colSpan={9} className="border-t bg-gray-50 p-0">
													{row.source === "budujesie" ? (
														<BudujesieThreadPanel row={row} />
													) : (
														<ValuationPanel id={row.id} />
													)}
												</td>
											</tr>
										)}
									</Fragment>
								);
							})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
