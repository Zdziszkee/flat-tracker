import type { SiteAdapter } from "../types.ts";
import { adresowoAdapter } from "./adresowo.ts";
import { airbnbAdapter } from "./airbnb.ts";
import { bookingAdapter } from "./booking.ts";
import { booksAdapter } from "./books.ts";
import { budujesieAdapter } from "./budujesie.ts";
import { domiportaAdapter } from "./domiporta.ts";
import { gethomeAdapter } from "./gethome.ts";
import { gratkaAdapter } from "./gratka.ts";
import { investmapAdapter } from "./investmap.ts";
import { komornikAdapter } from "./komornik.ts";
import { mapalicytacjiAdapter } from "./mapalicytacji.ts";
import { morizonAdapter } from "./morizon.ts";
import { nieruchomosciOnlineAdapter } from "./nieruchomosci-online.ts";
import { olxAdapter, olxRentAdapter } from "./olx.ts";
import { otodomAdapter, otodomRentAdapter } from "./otodom.ts";
import { quotesAdapter } from "./quotes.ts";
import { rynekpierwotnyAdapter } from "./rynekpierwotny.ts";
import { sprzedajemyAdapter } from "./sprzedajemy.ts";
import { tabelaofertAdapter } from "./tabelaofert.ts";

/** All site adapters available to the crawler. */
export const adapters: SiteAdapter[] = [
	otodomAdapter,
	otodomRentAdapter,
	olxAdapter,
	olxRentAdapter,
	adresowoAdapter,
	gethomeAdapter,
	sprzedajemyAdapter,
	tabelaofertAdapter,
	airbnbAdapter,
	bookingAdapter,
	morizonAdapter,
	gratkaAdapter,
	domiportaAdapter,
	nieruchomosciOnlineAdapter,
	rynekpierwotnyAdapter,
	komornikAdapter,
	mapalicytacjiAdapter,
	investmapAdapter,
	budujesieAdapter,
	quotesAdapter,
	booksAdapter,
];
