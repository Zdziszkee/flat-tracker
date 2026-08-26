import type { SiteAdapter } from "../types.ts";
import { airbnbAdapter } from "./airbnb.ts";
import { bookingAdapter } from "./booking.ts";
import { booksAdapter } from "./books.ts";
import { domiportaAdapter } from "./domiporta.ts";
import { gratkaAdapter } from "./gratka.ts";
import { investmapAdapter } from "./investmap.ts";
import { komornikAdapter } from "./komornik.ts";
import { morizonAdapter } from "./morizon.ts";
import { nieruchomosciOnlineAdapter } from "./nieruchomosci-online.ts";
import { olxAdapter, olxRentAdapter } from "./olx.ts";
import { otodomAdapter, otodomRentAdapter } from "./otodom.ts";
import { quotesAdapter } from "./quotes.ts";
import { rynekpierwotnyAdapter } from "./rynekpierwotny.ts";

/** All site adapters available to the crawler. */
export const adapters: SiteAdapter[] = [
	otodomAdapter,
	otodomRentAdapter,
	olxAdapter,
	olxRentAdapter,
	airbnbAdapter,
	bookingAdapter,
	morizonAdapter,
	gratkaAdapter,
	domiportaAdapter,
	nieruchomosciOnlineAdapter,
	rynekpierwotnyAdapter,
	komornikAdapter,
	investmapAdapter,
	quotesAdapter,
	booksAdapter,
];
