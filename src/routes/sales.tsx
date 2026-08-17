import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

interface SalesAnalytics {
	overall: {
		count: number;
		avgPrice: number | null;
		avgPricePerM2: number | null;
		avgArea: number | null;
	};
	byDistrict: Array<{
		district: string | null;
		count: number;
		avgPrice: number | null;
		avgPricePerM2: number | null;
		avgArea: number | null;
	}>;
}

function fmt(n: number | null | undefined): string {
	if (n == null) return "";
	return new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(n);
}

export const Route = createFileRoute("/sales")({
	component: SalesPage,
});

function SalesPage() {
	const { data, isLoading } = useQuery<SalesAnalytics>({
		queryKey: ["sales-analytics"],
		queryFn: () => fetch("/api/sales-analytics").then((r) => r.json()),
	});

	return (
		<div className="p-6">
			<div className="mb-4 flex items-center justify-between">
				<h1 className="text-xl font-semibold">
					Statystyki sprzedaży · Małopolska
				</h1>
				<div className="flex items-center gap-3 text-sm">
					<Link to="/rentals" className="text-blue-600 underline">
						Najem
					</Link>
					<Link to="/listings" className="text-blue-600 underline">
						Ogłoszenia
					</Link>
				</div>
			</div>

			{isLoading ? (
				<p className="text-sm text-gray-500">Ładowanie...</p>
			) : (
				<>
					<div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
						<div className="rounded border p-3">
							<div className="text-xs text-gray-500">Ofert</div>
							<div className="text-xl font-semibold">{data?.overall.count}</div>
						</div>
						<div className="rounded border p-3">
							<div className="text-xs text-gray-500">Śr. cena</div>
							<div className="text-xl font-semibold">
								{fmt(data?.overall.avgPrice)} zł
							</div>
						</div>
						<div className="rounded border p-3">
							<div className="text-xs text-gray-500">Śr. zł/m²</div>
							<div className="text-xl font-semibold">
								{fmt(data?.overall.avgPricePerM2)}
							</div>
						</div>
						<div className="rounded border p-3">
							<div className="text-xs text-gray-500">Śr. m²</div>
							<div className="text-xl font-semibold">
								{fmt(data?.overall.avgArea)}
							</div>
						</div>
					</div>

					<div className="overflow-x-auto rounded border">
						<table className="w-full text-sm">
							<thead className="bg-gray-50 text-left">
								<tr>
									<th className="px-3 py-2">Dzielnica</th>
									<th className="px-3 py-2 text-right">Ofert</th>
									<th className="px-3 py-2 text-right">Śr. cena</th>
									<th className="px-3 py-2 text-right">Śr. zł/m²</th>
									<th className="px-3 py-2 text-right">Śr. m²</th>
								</tr>
							</thead>
							<tbody>
								{(data?.byDistrict ?? []).map((r) => (
									<tr
										key={r.district ?? "?"}
										className="border-t hover:bg-gray-50"
									>
										<td className="px-3 py-1.5">{r.district ?? ""}</td>
										<td className="px-3 py-1.5 text-right">{r.count}</td>
										<td className="px-3 py-1.5 text-right">
											{fmt(r.avgPrice)} zł
										</td>
										<td className="px-3 py-1.5 text-right">
											{fmt(r.avgPricePerM2)}
										</td>
										<td className="px-3 py-1.5 text-right">{fmt(r.avgArea)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			)}
		</div>
	);
}
