import type { MarketCharts } from "#/types/market-charts";

export interface ChartCard {
	title: string;
	subtitle?: string;
	key: string;
	height?: number;
}

/** Card metadata for the analytics grid. Chart definitions stay in the page. */
export function buildChartCards(data: MarketCharts): ChartCard[] {
	return [
		{
			title: "1 · Liczba ofert wg przedziału czynszu",
			subtitle: `histogram najmu LT — mediana ${data.rentMeta.median} zł, średnia ${data.rentMeta.avg} zł`,
			key: "rentHistogram",
		},
		{
			title: "2 · Liczba ofert wg przedziału opłat (czynsz adm.)",
			subtitle: `histogram opłat — mediana ${data.oplatyMeta.median} zł, średnia ${data.oplatyMeta.avg} zł`,
			key: "oplatyHistogram",
		},
		{
			title: "3 · Liczba ofert wg kosztu łącznego (czynsz + opłaty)",
			subtitle: `histogram kosztu całkowitego — mediana ${data.totalMeta.median} zł, średnia ${data.totalMeta.avg} zł`,
			key: "totalHistogram",
		},
		{
			title: "4 · Trend cen transakcyjnych (RCN + GUGiK, 36 mies.)",
			subtitle: "avg zł/m² — gdzie rynek zmierza",
			key: "priceTrend",
		},
		{
			title: "5 · Wolumen transakcji miesięcznie",
			subtitle: "popyt — wolumen zwykle wyprzedza ceny",
			key: "txVolume",
		},
		{
			title: "6 · Nowe oferty miesięcznie",
			subtitle: "niebieska = sprzedaż, zielona = najem LT, czerwona = STR",
			key: "newSupply",
		},
		{
			title: "7 · Wzrost cen transakcyjnych r/r wg powiatu",
			subtitle:
				"średnia 12 mies. vs poprzednie 12 (min. 10 transakcji na okno)",
			key: "yoyByPowiat",
		},
		{
			title: "8 · Rentowność najmu długoterminowego wg miasta",
			subtitle: "czynsz roczny / cena sprzedaży",
			key: "grossYield",
		},
		{
			title: "9 · Cena ofertowa vs transakcyjna",
			subtitle:
				"niebieska = oferty, fioletowa = transakcje — luka = margines negocjacji",
			key: "offerVsTxGap",
		},
		{
			title: "10 · Pierwotny vs wtórny wg powiatu",
			subtitle: "pomarańczowy = pierwotny — premium nowej podaży",
			key: "primaryVsSecondary",
		},
		{
			title: "11 · Cena transakcyjna wg liczby pokoi",
			subtitle: "zł/m² — które typy mieszkań są cenione najwyżej",
			key: "txByRooms",
		},
		{
			title: "12 · Cena ofertowa zł/m² wg metrażu",
			subtitle: "kawalerki zwykle najdroższe za m²",
			key: "areaSegments",
		},
		{
			title: "13 · STR — cena nocna wg miesiąca",
			subtitle: "czerwona = Airbnb, granatowa = Booking — sezonowość",
			key: "strPriceByMonth",
		},
		{
			title: "14 · STR — obłożenie wg miesiąca",
			subtitle: "rezerwacje (bez blokad właścicieli) — szczyty popytu",
			key: "occupancyByMonth",
		},
		{
			title: "15 · STR — cena nocna wg dnia tygodnia",
			subtitle: "premia Pt/So = rynek weekendowy; płasko = najem pracowniczy",
			key: "weekdayPremium",
		},
		{
			title: "16 · STR — obłożenie wg miasta",
			subtitle: "gdzie kalendarze są najpełniej zajęte",
			key: "strOccupancy",
		},
		{
			title: "17 · Obłożenie STR vs rentowność LT",
			subtitle: "prawy górny róg = najlepsze miejsca pod najem inwestycyjny",
			key: "occupancyVsYield",
			height: 300,
		},
		{
			title: "18 · Cena nocna wg miasta (Airbnb vs Booking)",
			subtitle: "czerwona = Airbnb, granatowa = Booking",
			key: "nightlyByCity",
		},
		{
			title: "19 · % ofert z obniżką ceny (30 dni) wg miasta",
			subtitle:
				"udział ogłoszeń, których cena spadła w ciągu ostatnich 30 dni — rośnie z historią snapshots",
			key: "priceDrops",
		},
	];
}
