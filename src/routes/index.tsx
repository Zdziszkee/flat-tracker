import { createFileRoute, Link } from "@tanstack/react-router";
import { Dashboard } from "#/components/dashboard";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Separator } from "#/components/ui/separator";
import { DEFAULT_LISTING_SEARCH } from "#/lib/listing-features";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6">
			<nav className="flex flex-wrap gap-3" aria-label="Nawigacja główna">
				<Button asChild>
					<Link to="/map" search={DEFAULT_LISTING_SEARCH} preload="intent">
						Mapa ofert
					</Link>
				</Button>
				<Button asChild variant="outline">
					<Link to="/listings" search={DEFAULT_LISTING_SEARCH}>
						Lista ogłoszeń
					</Link>
				</Button>
				<Button asChild variant="outline">
					<Link to="/alerts">Alerty dnia</Link>
				</Button>
			</nav>

			<section
				aria-labelledby="dashboard-heading"
				className="flex flex-col gap-4"
			>
				<div>
					<h2 id="dashboard-heading" className="text-2xl font-semibold">
						Pulpit danych
					</h2>
					<p className="text-sm text-muted-foreground">
						Live z wykresów i stanu pozyskiwania danych.
					</p>
				</div>
				<Dashboard />
			</section>

			<Separator />

			<Card>
				<CardHeader>
					<CardTitle className="text-xl">
						<h2>Jak to działa</h2>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground">
						<li>
							Crawler (Crawlee + Cheerio) pobiera ogłoszenia z portali dla
							Małopolski i Śląska. Dane są zapisywane w SQLite (Drizzle).
						</li>
						<li>
							Każda oferta z współrzędnymi jest przypisywana do budynku z
							OpenStreetMap (Overpass API, test punkt-w-wielokącie).
						</li>
						<li>
							Historyczne ceny transakcyjne pochodzą z Rejestru Cen
							Nieruchomości (RCN) dla Krakowa oraz z usługi GUGiK Transakcje dla
							powiatów Małopolski i Śląska — dane publiczne, bezpłatne od lutego
							2026. Import odbywa się automatycznie przy każdym odświeżeniu
							danych.
						</li>
						<li>
							Na mapie każda oferta jest pokazywana na swoim budynku; popup
							zawiera średnie ceny transakcyjne dla tego budynku, jeśli są
							dostępne.
						</li>
					</ol>
				</CardContent>
			</Card>
		</main>
	);
}
