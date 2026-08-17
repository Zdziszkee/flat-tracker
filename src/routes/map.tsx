import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

// mapbox-gl touches `window` at module load, so it must never be imported
// during SSR. The lazy import is only triggered after mount on the client.
const MapView = lazy(() => import("../components/map-view"));

export const Route = createFileRoute("/map")({
	component: MapPage,
});

const SOURCE_LABELS: Record<string, string> = {
	otodom: "Otodom",
	olx: "OLX",
	morizon: "Morizon",
	gratka: "Gratka",
	domiporta: "Domiporta",
	"nieruchomosci-online": "Nieruchomosci-online",
	rynekpierwotny: "Rynekpierwotny",
	"licytacje-komornik": "Licytacje komornicze",
	"olx-rent": "OLX wynajem",
	airbnb: "Airbnb",
	booking: "Booking",
};

/** 0 = no time window (all offers). */
type DaysFilter = 0 | 1 | 7 | 30;

const DAY_OPTIONS: Array<{ value: DaysFilter; label: string }> = [
	{ value: 0, label: "Wszystkie" },
	{ value: 30, label: "Ostatnie 30 dni" },
	{ value: 7, label: "Ostatnie 7 dni" },
	{ value: 1, label: "Ostatnie 24 h" },
];

function MapPage() {
	const [source, setSource] = useState("all");
	const [days, setDays] = useState<DaysFilter>(0);
	const [offerType, setOfferType] = useState<"all" | "sale" | "rental">("all");
	const [sources, setSources] = useState<string[]>([]);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
		fetch("/api/sources")
			.then((r) => r.json())
			.then((d: { sources?: string[] }) => setSources(d.sources ?? []))
			.catch(() => {
				// Dropdown stays at "Wszystkie" if the fetch fails.
			});
	}, []);

	return (
		<div className="flex h-[calc(100vh-4rem)] flex-col">
			<header className="flex items-center justify-between border-b px-4 py-2">
				<h1 className="text-lg font-semibold">Mapa ofert · Małopolska</h1>
				<select
					value={source}
					onChange={(e) => setSource(e.target.value)}
					className="rounded border px-2 py-1 text-sm"
				>
					<option value="all">Wszystkie</option>
					{sources.map((s) => (
						<option key={s} value={s}>
							{SOURCE_LABELS[s] ?? s}
						</option>
					))}
				</select>
				<select
					value={offerType}
					onChange={(e) =>
						setOfferType(e.target.value as "all" | "sale" | "rental")
					}
					className="rounded border px-2 py-1 text-sm"
				>
					<option value="all">Wszystkie typy</option>
					<option value="sale">Sprzedaż</option>
					<option value="rental">Najem</option>
				</select>
				<select
					value={days}
					onChange={(e) => setDays(Number(e.target.value) as DaysFilter)}
					className="rounded border px-2 py-1 text-sm"
				>
					{DAY_OPTIONS.map((o) => (
						<option key={o.value} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				<Link to="/sales" className="text-sm text-blue-600 underline">
					Analityka sprzedaży
				</Link>
				<Link to="/rentals" className="text-sm text-blue-600 underline">
					Analityka najmu
				</Link>
			</header>

			<div className="relative flex-1">
				{!mounted ? (
					<div className="flex h-full items-center justify-center text-sm text-gray-500">
						Ładowanie mapy...
					</div>
				) : (
					<Suspense
						fallback={
							<div className="flex h-full items-center justify-center text-sm text-gray-500">
								Ładowanie mapy...
							</div>
						}
					>
						<MapView source={source} days={days} offerType={offerType} />
					</Suspense>
				)}
			</div>
		</div>
	);
}
