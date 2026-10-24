import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";

import { ListingFilters } from "#/components/listing-filters";
import { BudujesieThreadPanel } from "#/components/listings/budujesie-thread-panel";
import { PublicInvestmentsTable } from "#/components/listings/public-investments-table";
import { ValuationPanel } from "#/components/listings/valuation-panel";
import { Button } from "#/components/ui/button";
import { useListingFilters } from "#/hooks/use-listing-filters";
import { LISTINGS_PAGE_SIZE, useListingTable } from "#/hooks/use-listing-table";
import { usePublicInvestments } from "#/hooks/use-public-investments";
import { useSources } from "#/hooks/use-sources";
import { formatDate, formatNumber, realizationCaption } from "#/lib/format";
import {
	type ListingFacets,
	listingSearchSchema,
	PUBLIC_INVESTMENTS_KIND,
	searchFromFilters,
} from "#/lib/listing-features";
import type { PropertyKind } from "#/lib/property-kind";
import { sourceLabel } from "#/lib/sources";

export const Route = createFileRoute("/listings")({
	validateSearch: (search) => listingSearchSchema.parse(search),
	component: ListingsPage,
});

function ListingsPage() {
	const { filters, setFilters, page, setPage } = useListingFilters("/listings");
	const [expanded, setExpanded] = useState<number | null>(null);
	const showingPublicInvestments = filters.kind === PUBLIC_INVESTMENTS_KIND;
	const { data, isLoading } = useListingTable(filters, page);
	const { data: publicInvestments, isLoading: investmentsLoading } =
		usePublicInvestments(showingPublicInvestments);
	const { data: sources } = useSources();
	const sourceOptions = sources?.sources ?? ["otodom", "olx"];

	const rows = data?.listings ?? [];
	const facets: ListingFacets = {
		total: data?.facets.total ?? 0,
		bySource: new Map(Object.entries(data?.facets.bySource ?? {})),
		byKind: new Map(
			Object.entries(data?.facets.byKind ?? {}).map(
				([kind, count]) => [kind as PropertyKind, count] as const,
			),
		),
	};
	const totalPages = Math.max(
		1,
		Math.ceil((data?.total ?? 0) / (data?.pageSize ?? LISTINGS_PAGE_SIZE)),
	);
	// `page` is user-controlled (a hand-edited URL can say page=9999); the
	// API clamps its slice, so the controls must show the same effective page.
	const currentPage = Math.min(page, totalPages - 1);

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
						publicInvestmentsCount={
							showingPublicInvestments
								? publicInvestments?.features.length
								: undefined
						}
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

			{showingPublicInvestments ? (
				<PublicInvestmentsTable
					features={publicInvestments?.features ?? []}
					isLoading={investmentsLoading}
				/>
			) : (
				<>
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
										<td
											colSpan={9}
											className="px-3 py-6 text-center text-gray-500"
										>
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
														{expandable
															? expanded === row.id
																? "▾"
																: "▸"
															: ""}
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

					<div className="mt-3 flex items-center justify-between text-sm">
						<span className="text-gray-500">
							Strona {currentPage + 1} z {totalPages} · {data?.total ?? 0} ofert
						</span>
						<div className="flex gap-2">
							<Button
								variant="outline"
								disabled={currentPage === 0}
								onClick={() => setPage(currentPage - 1)}
							>
								Poprzednia
							</Button>
							<Button
								variant="outline"
								disabled={currentPage + 1 >= totalPages}
								onClick={() => setPage(currentPage + 1)}
							>
								Następna
							</Button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
