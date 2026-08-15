import type { CheerioAdapter, Listing } from "../types.ts";
import { formatAddressForGeocode, parseAddressFromText } from "./address.ts";
import { findLdNodes, parseLdJson } from "./ldjson.ts";
import { num, str } from "./ldoffer.ts";

/**
 * Domiporta embeds its results as an ItemList inside an @graph LD+JSON
 * block; each item is a Product/RealEstateListing with an Offer.
 */
export const domiportaAdapter: CheerioAdapter = {
	id: "domiporta",
	name: "Domiporta - Krakow flats for sale",
	kind: "cheerio",
	startUrls: [
		"https://www.domiporta.pl/mieszkanie/sprzedam/malopolskie/krakow",
	],
	maxRequestsPerCrawl: 40,

	async extractHtml(html, url, enqueue) {
		const nodes = parseLdJson(html);
		const items = findLdNodes(nodes, (n) => {
			const types = Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]];
			return types.includes("RealEstateListing") && typeof n.name === "string";
		});

		const listings: Listing[] = [];
		for (const item of items) {
			const listing = itemToListing(item);
			if (listing) listings.push(listing);
		}

		// Pagination: ?PageNumber=N (1-based).
		const current = Number.parseInt(
			new URL(url).searchParams.get("PageNumber") ?? "1",
			10,
		);
		const next = new URL(url);
		next.searchParams.set("PageNumber", String(current + 1));
		await enqueue([next.toString()]);

		return listings;
	},
};

function itemToListing(item: Record<string, unknown>): Listing | null {
	const title = str(item.name);
	const url = str(item.url);
	const offer = (item.offers ?? {}) as Record<string, unknown>;
	const price = num(offer.price);
	if (!title || !url || price === null) return null;

	// No structured address; parse street (+ number) from the title/description.
	const district = extractDistrict(title);
	const desc = str(item.description);
	const parsed = parseAddressFromText(desc) ?? parseAddressFromText(title);
	const address = parsed
		? formatAddressForGeocode(parsed.street, parsed.number, district)
		: null;

	return {
		source: "domiporta",
		externalId: url.split("/").filter(Boolean).pop() ?? url,
		url,
		title,
		price,
		pricePerM2: null,
		areaM2: null,
		rooms: null,
		floor: null,
		district,
		address,
		description: desc,
		heatingType: null,
		propertyType: null,
		features: null,
		lat: null,
		lng: null,
		listedAt: str(item.datePosted),
		scrapedAt: new Date().toISOString(),
	};
}

/** Titles look like "... Kraków Prądnik Biały, Prądnik Biały: Mackiewicza". */
function extractDistrict(title: string): string | null {
	const m = title.match(/Krak[oó]w\s+([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż-]+)/);
	return m ? m[1] : null;
}
