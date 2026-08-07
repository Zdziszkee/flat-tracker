import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

// Leaflet touches `window` at module load, so it must never be imported
// during SSR. The lazy import is only triggered after mount on the client.
const MapView = lazy(() => import("../components/map-view"));

export const Route = createFileRoute("/map")({
	component: MapPage,
});

function MapPage() {
	const [source, setSource] = useState<"all" | "otodom" | "olx">("all");
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	return (
		<div className="flex h-[calc(100vh-4rem)] flex-col">
			<header className="flex items-center justify-between border-b px-4 py-2">
				<h1 className="text-lg font-semibold">Mapa ofert · Kraków</h1>
				<select
					value={source}
					onChange={(e) => setSource(e.target.value as typeof source)}
					className="rounded border px-2 py-1 text-sm"
				>
					<option value="all">Wszystkie</option>
					<option value="otodom">Otodom</option>
					<option value="olx">OLX</option>
				</select>
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
						<MapView source={source} />
					</Suspense>
				)}
			</div>
		</div>
	);
}
