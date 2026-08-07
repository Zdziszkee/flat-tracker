import { useQuery } from "@tanstack/react-query";
import { divIcon } from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, Tooltip } from "react-leaflet";

import "leaflet/dist/leaflet.css";

export interface ApiListing {
	id: number;
	source: string;
	externalId: string;
	url: string;
	title: string;
	price: number | null;
	pricePerM2: number | null;
	areaM2: number | null;
	rooms: number | null;
	floor: string | null;
	district: string | null;
	lat: number | null;
	lng: number | null;
	listedAt: string | null;
	buildingId: number | null;
	buildingAddress: string | null;
	mapLat: number | null;
	mapLng: number | null;
	transactionStats: {
		buildingId: number;
		address: string | null;
		txCount: number;
		txAvgPricePerM2: number | null;
		txMinDate: string | number | null;
		txMaxDate: string | number | null;
	} | null;
}

interface ListingsResponse {
	listings: ApiListing[];
	summary: unknown[];
	generatedAt: string;
}

function priceColor(pricePerM2: number | null): string {
	if (!pricePerM2) return "#6b7280";
	if (pricePerM2 < 12000) return "#10b981"; // green: cheap
	if (pricePerM2 < 15000) return "#eab308"; // yellow
	if (pricePerM2 < 18000) return "#f97316"; // orange
	return "#ef4444"; // red: expensive
}

function formatPln(n: number | null): string {
	if (n === null) return "n/d";
	return new Intl.NumberFormat("pl-PL", {
		style: "currency",
		currency: "PLN",
		maximumFractionDigits: 0,
	}).format(n);
}

/** Extract the 4-digit year from a date string ("2022-05-30") or unix timestamp. */
function yearOf(d: string | number | null | undefined): string {
	if (d === null || d === undefined) return "";
	if (typeof d === "number") {
		return new Date(d * 1000).getUTCFullYear().toString();
	}
	return d.slice(0, 4);
}

function ListingMarker({ l }: { l: ApiListing }) {
	const color = priceColor(l.pricePerM2);
	const icon = divIcon({
		className: "",
		html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
		iconSize: [14, 14],
		iconAnchor: [7, 7],
	});

	return (
		<Marker position={[l.mapLat ?? 50.06, l.mapLng ?? 19.94]} icon={icon}>
			<Tooltip direction="top" offset={[0, -8]}>
				<span className="font-semibold">{formatPln(l.price)}</span>
			</Tooltip>
			<Popup>
				<div className="min-w-56 space-y-1 text-sm">
					<div className="font-semibold leading-tight">{l.title}</div>
					<div className="text-muted-foreground">
						{l.district ?? "Kraków"}
						{l.buildingAddress ? ` · ${l.buildingAddress}` : ""}
					</div>
					<div className="flex justify-between gap-4 pt-1">
						<span>{formatPln(l.price)}</span>
						<span>
							{l.pricePerM2 ? `${l.pricePerM2.toFixed(0)} zł/m²` : ""}
						</span>
					</div>
					<div className="text-muted-foreground">
						{l.areaM2 ? `${l.areaM2} m²` : ""}
						{l.rooms ? ` · ${l.rooms} pok.` : ""}
						{l.floor ? ` · ${l.floor}` : ""}
					</div>
					{l.transactionStats && (
						<div className="border-t pt-1 text-xs">
							<div className="font-medium text-amber-700">
								RCN history: {l.transactionStats.txCount} transakcji
							</div>
							<div>
								Śr. {formatPln(l.transactionStats.txAvgPricePerM2)}/m²
								{yearOf(l.transactionStats.txMinDate) &&
									` (${yearOf(l.transactionStats.txMinDate)}-${yearOf(l.transactionStats.txMaxDate)})`}
							</div>
						</div>
					)}
					<a
						href={l.url}
						target="_blank"
						rel="noreferrer"
						className="mt-1 block text-blue-600 underline"
					>
						Otwórz ogłoszenie
					</a>
				</div>
			</Popup>
		</Marker>
	);
}

export default function MapView({
	source,
}: {
	source: "all" | "otodom" | "olx";
}) {
	const { data, isLoading, error } = useQuery<ListingsResponse>({
		queryKey: ["listings"],
		queryFn: () => fetch("/api/listings").then((r) => r.json()),
	});

	const listings = (data?.listings ?? []).filter(
		(l) => source === "all" || l.source === source,
	);

	return (
		<div className="flex h-full flex-col">
			<div className="relative flex-1">
				{isLoading && (
					<div className="absolute inset-0 z-[1000] flex items-center justify-center bg-white/60 text-sm text-gray-600">
						Ładowanie ofert...
					</div>
				)}
				{error && (
					<div className="absolute inset-0 z-[1000] flex items-center justify-center bg-red-50 p-4 text-sm text-red-700">
						Nie udało się pobrać danych: {String(error)}
					</div>
				)}
				<MapContainer
					center={[50.061, 19.937]}
					zoom={13}
					className="h-full w-full"
					scrollWheelZoom
				>
					<TileLayer
						attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
						url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
					/>
					{listings.map((l) => (
						<ListingMarker key={`${l.source}-${l.externalId}`} l={l} />
					))}
				</MapContainer>
			</div>

			<footer className="flex items-center gap-4 border-t px-4 py-1.5 text-xs text-muted-foreground">
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500" />{" "}
					&lt;12k zł/m²
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-yellow-500" />{" "}
					12-15k
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-orange-500" />{" "}
					15-18k
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />{" "}
					&gt;18k zł/m²
				</span>
				<span className="ml-auto">
					Historia RCN: średnie ceny transakcyjne dla budynku
				</span>
			</footer>
		</div>
	);
}
