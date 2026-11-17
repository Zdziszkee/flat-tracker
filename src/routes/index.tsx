import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Separator } from "#/components/ui/separator";
import { DEFAULT_LISTING_SEARCH } from "#/lib/listing-features";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return (
		<div className="flex max-w-3xl flex-col gap-8 p-8">
			<header className="flex flex-col gap-4">
				<h1 className="text-4xl font-bold text-foreground">Flat Tracker</h1>
				<p className="text-lg text-muted-foreground">
					Mieszkania na sprzedaż w Małopolsce i na Śląsku: oferty z Otodom i OLX
					połączone z historycznymi cenami transakcyjnymi (Rejestr Cen
					Nieruchomości).
				</p>
			</header>

			<nav className="flex flex-wrap gap-3">
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
					<Link to="/sources">Data sources</Link>
				</Button>
				<Button asChild>
					<Link to="/alerts">Alerty dnia</Link>
				</Button>
			</nav>

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
							Crawler (Crawlee + Cheerio) pobiera ogłoszenia z{" "}
							<a
								className="text-primary underline"
								href="https://www.otodom.pl"
								target="_blank"
								rel="noreferrer"
							>
								otodom.pl
							</a>{" "}
							i{" "}
							<a
								className="text-primary underline"
								href="https://www.olx.pl"
								target="_blank"
								rel="noreferrer"
							>
								olx.pl
							</a>{" "}
							dla Małopolski i Śląska. Dane są zapisywane w SQLite (Drizzle).
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
		</div>
	);
}
