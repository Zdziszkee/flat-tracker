import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useState } from "react";

import { ListingFilters } from "#/components/listing-filters";
import { BudujesieThreadPanel } from "#/components/listings/budujesie-thread-panel";
import { ListingRecordPanel } from "#/components/listings/listing-record-panel";
import { PublicInvestmentsTable } from "#/components/listings/public-investments-table";
import { ValuationPanel } from "#/components/listings/valuation-panel";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
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
import {
	KIND_LABEL,
	OFFER_LABEL,
	OFFER_TONE,
	offerTypeOf,
} from "#/lib/listing-schema";
import type { PropertyKind } from "#/lib/property-kind";
import { sourceLabel } from "#/lib/sources";
import { cn } from "#/lib/utils";

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
		<div className="flex flex-col gap-4 p-6">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<h1 className="text-xl font-semibold">
					Ogłoszenia · Małopolska i Śląsk
				</h1>
				<div className="flex flex-wrap items-end gap-3">
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
					<Button variant="ghost" size="sm" asChild>
						<Link
							to="/map"
							search={searchFromFilters(filters)}
							preload="intent"
						>
							Mapa
						</Link>
					</Button>
					<Button variant="ghost" size="sm" asChild>
						<Link to="/sources">Data sources</Link>
					</Button>
					<Button variant="ghost" size="sm" asChild>
						<Link to="/alerts">Alerty</Link>
					</Button>
				</div>
			</div>

			{showingPublicInvestments ? (
				<PublicInvestmentsTable
					features={publicInvestments?.features ?? []}
					isLoading={investmentsLoading}
				/>
			) : (
				<>
					<div className="rounded-lg border">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="px-3">Źródło</TableHead>
									<TableHead className="px-3">Oferta</TableHead>
									<TableHead className="px-3">Tytuł</TableHead>
									<TableHead className="px-3 text-right">Cena</TableHead>
									<TableHead className="px-3 text-right">zł/m²</TableHead>
									<TableHead className="px-3 text-right">m²</TableHead>
									<TableHead className="px-3 text-right">Pokoje</TableHead>
									<TableHead className="px-3">Budynek</TableHead>
									<TableHead className="px-3">Ogrzewanie</TableHead>
									<TableHead className="px-3">Dzielnica</TableHead>
									<TableHead className="px-3">Data dodania</TableHead>
									<TableHead className="px-2" aria-label="wycena" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{isLoading && (
									<TableRow className="hover:bg-transparent">
										<TableCell
											colSpan={12}
											className="px-3 py-6 text-center text-muted-foreground"
										>
											Ładowanie...
										</TableCell>
									</TableRow>
								)}
								{!isLoading && rows.length === 0 && (
									<TableRow className="hover:bg-transparent">
										<TableCell
											colSpan={12}
											className="px-3 py-6 text-center text-muted-foreground"
										>
											Brak ofert dla wybranych filtrów.
										</TableCell>
									</TableRow>
								)}
								{!isLoading &&
									rows.map((row) => {
										// Every row opens: the panel shows the full database record
										// (and, for offers, the valuation).
										const isExpanded = expanded === row.id;
										const kind = row.propertyKind ?? null;
										const offer = offerTypeOf(row.offerType);
										const isPlot = kind === "plot";
										const toggle = () =>
											setExpanded(isExpanded ? null : row.id);
										return (
											<Fragment key={`${row.source}-${row.id}`}>
												<TableRow
													className="cursor-pointer"
													aria-expanded={isExpanded}
													onClick={toggle}
												>
													<TableCell className="px-3 py-1.5">
														<Badge variant="secondary">
															{sourceLabel(row.source)}
														</Badge>
													</TableCell>
													<TableCell className="px-3 py-1.5">
														<div className="flex flex-col gap-0.5">
															<Badge
																variant="outline"
																className={cn("w-fit", OFFER_TONE[offer])}
															>
																{OFFER_LABEL[offer]}
															</Badge>
															{kind && (
																<span className="text-[10px] text-muted-foreground">
																	{KIND_LABEL[kind]}
																</span>
															)}
														</div>
													</TableCell>
													<TableCell className="max-w-96 px-3 py-1.5">
														<div className="truncate">
															<a
																href={row.url}
																target="_blank"
																rel="noreferrer"
																className="hover:underline"
																onClick={(event) => event.stopPropagation()}
															>
																{row.title}
															</a>
														</div>
														{row.constructionEndLabel && (
															<div className="truncate text-xs text-amber-400">
																{realizationCaption(
																	row.constructionEndLabel,
																	row.constructionEndDate,
																)}
															</div>
														)}
													</TableCell>
													<TableCell className="px-3 py-1.5 text-right font-medium">
														{formatNumber(row.price)}
													</TableCell>
													<TableCell className="px-3 py-1.5 text-right">
														{formatNumber(row.pricePerM2)}
													</TableCell>
													<TableCell className="px-3 py-1.5 text-right">
														{formatNumber(row.areaM2 ?? row.plotAreaM2)}
													</TableCell>
													<TableCell className="px-3 py-1.5 text-right">
														{row.rooms ?? ""}
													</TableCell>
													<TableCell className="px-3 py-1.5 text-muted-foreground">
														{isPlot ? "—" : (row.buildingClass ?? "")}
													</TableCell>
													<TableCell className="px-3 py-1.5 text-muted-foreground">
														{isPlot ? "—" : (row.heatingLabel ?? "")}
													</TableCell>
													<TableCell className="px-3 py-1.5">
														{row.district ?? ""}
													</TableCell>
													<TableCell className="px-3 py-1.5 text-muted-foreground">
														{formatDate(row.listedAt ?? row.firstSeenAt)}
													</TableCell>
													<TableCell className="px-2 py-1.5 text-center text-muted-foreground">
														<Button
															variant="ghost"
															size="icon-xs"
															aria-label={
																isExpanded
																	? "Zwiń szczegóły"
																	: "Pokaż szczegóły"
															}
															onClick={(event) => {
																event.stopPropagation();
																toggle();
															}}
														>
															{isExpanded ? <ChevronDown /> : <ChevronRight />}
														</Button>
													</TableCell>
												</TableRow>
												{isExpanded && (
													<TableRow className="hover:bg-transparent">
														<TableCell
															colSpan={12}
															className="bg-muted/30 p-0 whitespace-normal"
														>
															{row.source === "budujesie" ? (
																<BudujesieThreadPanel row={row} />
															) : (
																<ValuationPanel id={row.id} />
															)}
															<ListingRecordPanel id={row.id} />
														</TableCell>
													</TableRow>
												)}
											</Fragment>
										);
									})}
							</TableBody>
						</Table>
					</div>

					<div className="flex items-center justify-between text-sm">
						<span className="text-muted-foreground">
							Strona {currentPage + 1} z {totalPages} · {data?.total ?? 0} ofert
						</span>
						<div className="flex gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={currentPage === 0}
								onClick={() => setPage(currentPage - 1)}
							>
								Poprzednia
							</Button>
							<Button
								variant="outline"
								size="sm"
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
