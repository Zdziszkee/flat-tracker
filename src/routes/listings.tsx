import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

interface Row {
	id: number;
	source: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	district: string | null;
	url: string;
	listedAt: string | null;
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
};

function addedWithin(listedAt: string | null, days: DaysFilter): boolean {
	if (days === 0) return true;
	if (!listedAt) return false;
	return Date.now() - new Date(listedAt).getTime() <= days * 24 * 3600 * 1000;
}

export const Route = createFileRoute("/listings")({
	component: ListingsPage,
});

function ListingsPage() {
	const [source, setSource] = useState("all");
	const [days, setDays] = useState<DaysFilter>(0);
	const { data, isLoading } = useQuery<ListingsResponse>({
		queryKey: ["listings"],
		queryFn: () => fetch("/api/listings").then((r) => r.json()),
	});
	const { data: sources } = useQuery<{ sources: string[] }>({
		queryKey: ["sources"],
		queryFn: () => fetch("/api/sources").then((r) => r.json()),
	});
	const sourceOptions = sources?.sources ?? ["otodom", "olx"];

	const rows = (data?.listings ?? []).filter(
		(r) =>
			(source === "all" || r.source === source) &&
			addedWithin(r.listedAt, days),
	);

	return (
		<div className="p-6">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">Ogłoszenia · Kraków</h1>
				<div className="flex items-center gap-3 text-sm">
					<select
						value={source}
						onChange={(e) => setSource(e.target.value)}
						className="rounded border px-2 py-1"
					>
						<option value="all">
							Wszystkie ({data?.listings.length ?? 0})
						</option>
						{sourceOptions.map((s) => (
							<option key={s} value={s}>
								{SOURCE_LABELS[s] ?? s}
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
						</tr>
					</thead>
					<tbody>
						{isLoading && (
							<tr>
								<td colSpan={8} className="px-3 py-6 text-center text-gray-500">
									Ładowanie...
								</td>
							</tr>
						)}
						{!isLoading &&
							rows.map((r) => (
								<tr
									key={`${r.source}-${r.id}`}
									className="border-t hover:bg-gray-50"
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
										{r.listedAt
											? new Date(r.listedAt).toLocaleDateString("pl-PL")
											: ""}
									</td>
								</tr>
							))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
