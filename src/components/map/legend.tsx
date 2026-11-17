/**
 * Legend pinned to the bottom of the map. Colours mirror SOURCE_COLORS and the
 * layer paint definitions; keep them in sync when a layer changes.
 */
export function MapLegend({
	showParcels,
	showOccupancy,
}: {
	showParcels: boolean;
	showOccupancy: boolean;
}) {
	return (
		<footer className="pointer-events-none absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-4 rounded-lg bg-popover/90 px-4 py-1.5 text-xs text-muted-foreground shadow ring-1 ring-border backdrop-blur">
			<span className="flex items-center gap-1">
				<span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-500" />{" "}
				budynek z historią RCN
			</span>
			<span className="flex items-center gap-1">
				<span className="inline-block h-2.5 w-2.5 rounded-sm bg-gray-300" /> bez
				historii
			</span>
			{showParcels && (
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-sm border border-slate-400" />{" "}
					granice działek (od zbliżenia 14)
				</span>
			)}
			<span className="flex items-center gap-1">
				<span className="inline-block h-2.5 w-2.5 rounded-sm border border-amber-700/50 bg-amber-400/25" />{" "}
				działka z historią RCN
			</span>
			<span className="flex items-center gap-1">
				<span className="inline-block h-1 w-4 rounded-full bg-slate-300 ring-1 ring-slate-900" />{" "}
				kolej
			</span>
			<span className="flex items-center gap-1">
				<span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-100 ring-1 ring-slate-900" />{" "}
				stacja kolejowa
			</span>
			{showOccupancy && (
				<>
					<span className="mx-1 h-3 w-px bg-border" />
					<span className="flex items-center gap-1">
						<span className="inline-block h-2.5 w-2.5 rounded-sm bg-blue-500" />{" "}
						niskie
					</span>
					<span className="flex items-center gap-1">
						<span className="inline-block h-2.5 w-2.5 rounded-sm bg-green-500" />{" "}
						średnie
					</span>
					<span className="flex items-center gap-1">
						<span className="inline-block h-2.5 w-2.5 rounded-sm bg-yellow-500" />{" "}
						wysokie
					</span>
					<span className="flex items-center gap-1">
						<span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-500" />{" "}
						bardzo wysokie
					</span>
				</>
			)}
			<span className="mx-1 h-3 w-px bg-border" />
			<span className="flex items-center gap-1">
				<span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-600 ring-2 ring-white" />{" "}
				liczba ofert w kółku (od zbliżenia 13 pojedyncze oferty)
			</span>
			<span className="text-muted-foreground">kolor kropki = źródło</span>
		</footer>
	);
}
