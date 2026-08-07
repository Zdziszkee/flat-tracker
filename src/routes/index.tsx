import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<div className="p-8">
			<h1 className="text-4xl font-bold">Flat Tracker Kraków</h1>
			<p className="mt-4 text-lg">
				Mieszkania na sprzedaż w Krakowie: oferty z Otodom i OLX połączone z
				historycznymi cenami transakcyjnymi (Rejestr Cen Nieruchomości).
			</p>

			<nav className="mt-8 flex gap-4">
				<Link
					to="/map"
					className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
				>
					Mapa ofert
				</Link>
				<Link
					to="/listings"
					className="rounded-lg border px-4 py-2 font-medium hover:bg-gray-100"
				>
					Lista ogłoszeń
				</Link>
			</nav>

			<section className="mt-10 max-w-3xl space-y-4 text-sm leading-relaxed">
				<h2 className="text-xl font-semibold">Jak to działa</h2>
				<ol className="list-decimal space-y-2 pl-5">
					<li>
						Crawler (Crawlee + Cheerio) pobiera ogłoszenia z{" "}
						<a
							className="text-blue-600 underline"
							href="https://www.otodom.pl"
							target="_blank"
							rel="noreferrer"
						>
							otodom.pl
						</a>{" "}
						i{" "}
						<a
							className="text-blue-600 underline"
							href="https://www.olx.pl"
							target="_blank"
							rel="noreferrer"
						>
							olx.pl
						</a>{" "}
						dla Krakowa. Dane są zapisywane w SQLite (Drizzle).
					</li>
					<li>
						Każda oferta z współrzędnymi jest przypisywana do budynku z
						OpenStreetMap (Overpass API, test punkt-w-wielokącie).
					</li>
					<li>
						Historyczne ceny transakcyjne pochodzą z Rejestru Cen Nieruchomości
						(RCN) dla Krakowa — dane publiczne, bezpłatne od lutego 2026.
						Import: <code>npm run import-rcn</code>.
					</li>
					<li>
						Na mapie każda oferta jest pokazywana na swoim budynku; popup
						zawiera średnie ceny transakcyjne dla tego budynku, jeśli są
						dostępne.
					</li>
				</ol>
			</section>
		</div>
	);
}
