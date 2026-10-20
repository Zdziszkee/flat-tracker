import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import {
	dateLabel,
	formatDate,
	formatNumber,
	realizationCaption,
} from "#/lib/format";
import {
	DAY_OPTIONS,
	type DaysFilter,
	filterListings,
	listingFacets,
	parseListingFeatures,
} from "#/lib/listing-features";
import { PROPERTY_KIND_LABELS, type PropertyKind } from "#/lib/property-kind";
import { sourceLabel } from "#/lib/sources";
import type {
	ListingDto,
	ListingsResponse,
	OfferValuation,
} from "#/types/listing";

function ValuationPanel({ id }: { id: number }) {
	const { data, isLoading } = useQuery<OfferValuation>({
		queryKey: ["valuation-offer", id],
		queryFn: () => fetch(`/api/valuation/offer?id=${id}`).then((r) => r.json()),
	});
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
	const c = data.comps;
	const compRow = (label: string, v: { avgM2: number; n: number } | null) =>
		v ? (
			<div className="flex justify-between">
				<span className="text-gray-500">{label}</span>
				<span>
					{formatNumber(Math.round(v.avgM2))} zł/m²
					<span className="text-gray-400"> ({v.n})</span>
				</span>
			</div>
		) : null;
	return (
		<div className="space-y-2 bg-gray-50 px-6 py-3 text-xs">
			<div className="flex items-center gap-2">
				<span className="font-medium">Wycena:</span>
				{c.fairM2 != null && (
					<span>
						wartość godziwa <b>{formatNumber(c.fairM2)} zł/m²</b>
						{data.offer.pricePerM2 != null && (
							<span className="text-gray-500">
								{" "}
								(oferta {formatNumber(Math.round(data.offer.pricePerM2))})
							</span>
						)}
					</span>
				)}
				{data.rating && (
					<span
						className={`rounded px-1.5 py-0.5 font-medium ${data.rating.tone} bg-white`}
					>
						{data.rating.label}
						{data.overUnderPct != null &&
							` ${data.overUnderPct > 0 ? "+" : ""}${data.overUnderPct}%`}
					</span>
				)}
			</div>
			<div className="space-y-0.5">
				{compRow("To samo budynku", c.building)}
				{compRow("Okolica", c.area)}
				{compRow("Transakcje RCN (1 km, 24 mies.)", c.rcn)}
			</div>
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

/**
 * Forum investment detail: the topic description with the comments under it
 * (scraped from the thread's first page into features.posts).
 */
function BudujesieThreadPanel({ row }: { row: ListingDto }) {
	const features = parseListingFeatures(row.features);
	const posts = features.budujesie?.posts ?? [];
	const opText = posts[0]?.text ?? "";
	const comments = posts.slice(1, 8);
	if (!opText && comments.length === 0) {
		return (
			<div className="p-4 text-sm text-gray-500">
				Brak pobranej treści wątku — odśwież źródło, aby pobrać opis inwestycji
				i komentarze.
			</div>
		);
	}
	return (
		<div className="p-4 text-sm">
			{opText && (
				<div>
					<div className="font-medium text-amber-700">Inwestycja</div>
					<p className="mt-1 whitespace-pre-wrap text-gray-700">{opText}</p>
				</div>
			)}
			{comments.length > 0 && (
				<div className="mt-3">
					<div className="font-medium text-amber-700">Komentarze</div>
					{comments.map((c, i) => (
						<div
							key={`${c.author ?? "anonim"}-${c.at ?? i}`}
							className="mt-2 border-l-2 border-amber-200 pl-2 text-gray-700"
						>
							<span className="font-medium">{c.author ?? "anonim"}</span>
							{dateLabel(c.at) ? (
								<span className="text-gray-400"> · {dateLabel(c.at)}</span>
							) : null}
							<p className="whitespace-pre-wrap">{c.text ?? ""}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute("/listings")({
	component: ListingsPage,
});

function ListingsPage() {
	const [source, setSource] = useState("all");
	const [days, setDays] = useState<DaysFilter>(0);
	const [kind, setKind] = useState<PropertyKind | "all">("all");
	const [expanded, setExpanded] = useState<number | null>(null);
	const { data, isLoading } = useQuery<ListingsResponse>({
		queryKey: ["listings"],
		queryFn: () => fetch("/api/listings").then((r) => r.json()),
	});
	const { data: sources } = useQuery<{ sources: string[] }>({
		queryKey: ["sources"],
		queryFn: () => fetch("/api/sources").then((r) => r.json()),
	});
	const sourceOptions = sources?.sources ?? ["otodom", "olx"];

	const allRows = data?.listings ?? [];
	const facets = listingFacets(allRows, days);
	const rows = filterListings(allRows, {
		source,
		days,
		kind,
		offerType: "all",
	});

	return (
		<div className="p-6">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">
					Ogłoszenia · Małopolska i Śląsk
				</h1>
				<div className="flex items-center gap-3 text-sm">
					<select
						value={source}
						onChange={(e) => setSource(e.target.value)}
						className="rounded border px-2 py-1"
						aria-label="Źródło"
					>
						<option value="all">Wszystkie ({facets.total})</option>
						{sourceOptions.map((s) => (
							<option key={s} value={s}>
								{sourceLabel(s)} ({facets.bySource.get(s) ?? 0})
							</option>
						))}
					</select>
					<select
						value={kind}
						onChange={(e) => setKind(e.target.value as PropertyKind | "all")}
						className="rounded border px-2 py-1"
						aria-label="Rodzaj nieruchomości"
					>
						<option value="all">Wszystkie ({facets.total})</option>
						{(Object.keys(PROPERTY_KIND_LABELS) as Array<PropertyKind>).map(
							(k) => (
								<option key={k} value={k}>
									{PROPERTY_KIND_LABELS[k]} ({facets.byKind.get(k) ?? 0})
								</option>
							),
						)}
					</select>
					<select
						value={days}
						onChange={(e) => setDays(Number(e.target.value) as DaysFilter)}
						className="rounded border px-2 py-1"
						aria-label="Data dodania"
					>
						{DAY_OPTIONS.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
					<Link to="/map" className="text-blue-600 underline">
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
							rows.map((r) => {
								const expandable =
									r.offerType === "sale" ||
									r.offerType === "long_term_rental" ||
									r.source === "budujesie";
								return (
									<Fragment key={`${r.source}-${r.id}`}>
										<tr
											className={`border-t ${expandable ? "cursor-pointer hover:bg-gray-50" : ""}`}
											onClick={() => {
												if (!expandable) return;
												setExpanded(expanded === r.id ? null : r.id);
											}}
										>
											<td className="px-3 py-1.5">
												<span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
													{sourceLabel(r.source)}
												</span>
											</td>
											<td className="max-w-96 px-3 py-1.5">
												<div className="truncate">
													<a
														href={r.url}
														target="_blank"
														rel="noreferrer"
														className="hover:text-blue-600 hover:underline"
													>
														{r.title}
													</a>
												</div>
												{r.constructionEndLabel && (
													<div className="truncate text-xs text-amber-700">
														{realizationCaption(
															r.constructionEndLabel,
															r.constructionEndDate,
														)}
													</div>
												)}
											</td>
											<td className="px-3 py-1.5 text-right font-medium">
												{formatNumber(r.price)}
											</td>
											<td className="px-3 py-1.5 text-right">
												{formatNumber(r.pricePerM2)}
											</td>
											<td className="px-3 py-1.5 text-right">
												{formatNumber(r.areaM2)}
											</td>
											<td className="px-3 py-1.5 text-right">
												{r.rooms ?? ""}
											</td>
											<td className="px-3 py-1.5">{r.district ?? ""}</td>
											<td className="px-3 py-1.5 text-gray-500">
												{formatDate(r.listedAt ?? r.firstSeenAt)}
											</td>
											<td className="px-2 py-1.5 text-center text-gray-400">
												{expandable ? (expanded === r.id ? "▾" : "▸") : ""}
											</td>
										</tr>
										{expanded === r.id && (
											<tr>
												<td colSpan={9} className="border-t bg-gray-50 p-0">
													{r.source === "budujesie" ? (
														<BudujesieThreadPanel row={r} />
													) : (
														<ValuationPanel id={r.id} />
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
