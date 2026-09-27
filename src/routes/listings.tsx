import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

interface Row {
	id: number;
	source: string;
	offerType: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	district: string | null;
	url: string;
	listedAt: string | null;
	firstSeenAt: string | null;
	heatingType: string | null;
	propertyType: string | null;
	features: string | null;
}

interface ListingsResponse {
	listings: Row[];
	generatedAt: string;
}

function fmt(n: number | null): string {
	if (n === null) return "";
	return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(n);
}

/** 0 = no time window (all offers). */
type DaysFilter = 0 | 1 | 7 | 30;

const DAY_OPTIONS: Array<{ value: DaysFilter; label: string }> = [
	{ value: 0, label: "Wszystkie" },
	{ value: 30, label: "Ostatnie 30 dni" },
	{ value: 7, label: "Ostatnie 7 dni" },
	{ value: 1, label: "Ostatnie 24 h" },
];

const SOURCE_LABELS: Record<string, string> = {
	otodom: "Otodom",
	olx: "OLX",
	morizon: "Morizon",
	gratka: "Gratka",
	domiporta: "Domiporta",
	"nieruchomosci-online": "Nieruchomosci-online",
	rynekpierwotny: "Rynekpierwotny",
	"licytacje-komornik": "Licytacje komornicze",
	budujesie: "BudujeSie (w budowie)",
	airbnb: "Airbnb",
	booking: "Booking",
};

interface OfferValuation {
	offer: {
		id: number;
		price: number | null;
		pricePerM2: number | null;
		areaM2: number | null;
		offerType: string;
	};
	comps: {
		building: { avgM2: number; n: number } | null;
		area: { avgM2: number; n: number } | null;
		rcn: { avgM2: number; n: number } | null;
		fairM2: number | null;
	};
	overUnderPct: number | null;
	rating: { label: string; tone: string } | null;
	lt: {
		rentAvg: number;
		czynszAvg: number;
		n: number;
		basis: string;
		netMonthly: number;
		netYearly: number;
		netYieldPct: number | null;
	} | null;
	str: {
		nightlyAvg: number;
		occupancy: number;
		n: number;
		basis: string;
		netMonthly: number;
		netYearly: number;
		netYieldPct: number | null;
	} | null;
}

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
					{Math.round(v.avgM2).toLocaleString("pl-PL")} zł/m²
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
						wartość godziwa <b>{c.fairM2.toLocaleString("pl-PL")} zł/m²</b>
						{data.offer.pricePerM2 != null && (
							<span className="text-gray-500">
								{" "}
								(oferta{" "}
								{Math.round(data.offer.pricePerM2).toLocaleString("pl-PL")})
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
							{data.lt.rentAvg.toLocaleString("pl-PL")} zł −{" "}
							{data.lt.czynszAvg.toLocaleString("pl-PL")} opłaty =
							<b> {data.lt.netMonthly.toLocaleString("pl-PL")} zł/mies.</b>
						</div>
						<div className="text-gray-500">
							rocznie netto {data.lt.netYearly.toLocaleString("pl-PL")} zł · ROI{" "}
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
							{data.str.nightlyAvg.toLocaleString("pl-PL")} zł/noc ×{" "}
							{(data.str.occupancy * 100).toFixed(0)}% obłożenia =
							<b> {data.str.netMonthly.toLocaleString("pl-PL")} zł/mies.</b>
						</div>
						<div className="text-gray-500">
							rocznie netto {data.str.netYearly.toLocaleString("pl-PL")} zł ·
							ROI <b>{data.str.netYieldPct?.toFixed(1) ?? "—"}%</b> (
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

function addedWithin(listedAt: string | null, days: DaysFilter): boolean {
	if (days === 0) return true;
	if (!listedAt) return false;
	return Date.now() - new Date(listedAt).getTime() <= days * 24 * 3600 * 1000;
}

function addedLabel(row: Row): string {
	const added = row.listedAt ?? row.firstSeenAt;
	return added ? new Date(added).toLocaleDateString("pl-PL") : "";
}

interface ThreadPostView {
	author?: string | null;
	at?: string | null;
	text?: string;
}

/** Forum investment detail: the topic description with the comments under
 * it (scraped from the thread's first page into features.posts). */
function BudujesieThreadPanel({ row }: { row: Row }) {
	let posts: ThreadPostView[] = [];
	try {
		const f: unknown = row.features ? JSON.parse(row.features) : null;
		const raw =
			f && typeof f === "object" ? (f as { posts?: unknown }).posts : null;
		if (Array.isArray(raw)) posts = raw as ThreadPostView[];
	} catch {
		// malformed features JSON: no posts
	}
	const opText = posts[0]?.text ?? "";
	const comments = posts.slice(1, 8);
	const dateLabel = (at?: string | null): string => {
		if (!at) return "";
		const d = new Date(at);
		return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pl-PL");
	};
	if (!opText && comments.length === 0)
		return (
			<div className="p-4 text-sm text-gray-500">
				Brak pobranej treści wątku — odśwież źródło, aby pobrać opis inwestycji
				i komentarze.
			</div>
		);
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
	// Counts must respect the active time window so every option shows how
	// many offers it would actually list when selected.
	const daysRows = allRows.filter(
		// Construction investments are long-lived inventory: the fresh-offers
		// window must not hide them (same rule as the map).
		(r) =>
			r.source === "budujesie" ||
			addedWithin(r.listedAt ?? r.firstSeenAt, days),
	);
	const countsBySource = new Map<string, number>();
	for (const r of daysRows) {
		countsBySource.set(r.source, (countsBySource.get(r.source) ?? 0) + 1);
	}

	const rows = daysRows.filter((r) => source === "all" || r.source === source);

	return (
		<div className="p-6">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">Ogłoszenia · Małopolska</h1>
				<div className="flex items-center gap-3 text-sm">
					<select
						value={source}
						onChange={(e) => setSource(e.target.value)}
						className="rounded border px-2 py-1"
					>
						<option value="all">Wszystkie ({daysRows.length})</option>
						{sourceOptions.map((s) => (
							<option key={s} value={s}>
								{SOURCE_LABELS[s] ?? s} ({countsBySource.get(s) ?? 0})
							</option>
						))}
					</select>
					<select
						value={days}
						onChange={(e) => setDays(Number(e.target.value) as DaysFilter)}
						className="rounded border px-2 py-1"
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
							rows.map((r) => (
								<>
									<tr
										key={`${r.source}-${r.id}`}
										className={`border-t ${r.offerType === "sale" || r.offerType === "long_term_rental" ? "cursor-pointer hover:bg-gray-50" : ""}`}
										onClick={() => {
											if (
												r.offerType !== "sale" &&
												r.offerType !== "long_term_rental"
											) {
												return;
											}
											setExpanded(expanded === r.id ? null : r.id);
										}}
									>
										<td className="px-3 py-1.5">
											<span
												className={
													r.source === "otodom"
														? "rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700"
														: "rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700"
												}
											>
												{r.source}
											</span>
										</td>
										<td className="max-w-96 truncate px-3 py-1.5">
											<a
												href={r.url}
												target="_blank"
												rel="noreferrer"
												className="hover:text-blue-600 hover:underline"
											>
												{r.title}
											</a>
										</td>
										<td className="px-3 py-1.5 text-right font-medium">
											{fmt(r.price)}
										</td>
										<td className="px-3 py-1.5 text-right">
											{fmt(r.pricePerM2)}
										</td>
										<td className="px-3 py-1.5 text-right">{fmt(r.areaM2)}</td>
										<td className="px-3 py-1.5 text-right">{r.rooms ?? ""}</td>
										<td className="px-3 py-1.5">{r.district ?? ""}</td>
										<td className="px-3 py-1.5 text-gray-500">
											{addedLabel(r)}
										</td>
										<td className="px-2 py-1.5 text-center text-gray-400">
											{r.offerType === "sale" ||
											r.offerType === "long_term_rental"
												? expanded === r.id
													? "▾"
													: "▸"
												: ""}
										</td>
									</tr>
									{expanded === r.id && (
										<tr key={`${r.source}-${r.id}-x`}>
											<td colSpan={9} className="border-t bg-gray-50 p-0">
												{r.source === "budujesie" ? (
													<BudujesieThreadPanel row={r} />
												) : (
													<ValuationPanel id={r.id} />
												)}
											</td>
										</tr>
									)}
								</>
							))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
