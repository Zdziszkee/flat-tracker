import { REGIONS } from "../regions.ts";
import type { CheerioAdapter, Listing } from "../types.ts";
import { cleanText } from "./html-entities.ts";
import { num, str } from "./ldoffer.ts";
import { propertyTypeFromValue } from "./property-type.ts";

/**
 * GetHome.pl — an agency-network portal with a nationwide inventory that
 * is unusually data-rich: the search page embeds `window.__INITIAL_STATE__`
 * with every offer's price, area, rooms, floor, building year, exact
 * coordinates, address, agency and creation timestamp. No detail pass is
 * needed.
 *
 * Two sale lists per voivodeship: `/nieruchomosci/<region>` (flats and
 * houses) and `/dzialki/<region>` (plots). Pagination is `?page=N`; the
 * state carries `page`/`pageCount`, so a crawl stops at the real end.
 *
 * The list includes primary-market units as well, so new developments mix
 * with the secondary market (the `market_type` value rides to `features`
 * and is promoted by db-sink).
 */

const BASE = "https://gethome.pl";
const PAGE_SIZE_HINT = 35;

interface GhPrice {
	total?: number | string | null;
	per_sqm?: number | string | null;
	currency?: string | null;
}

interface GhProperty {
	type?: string | null;
	size?: number | string | null;
	lot_size?: number | string | null;
	room_number?: number | string | null;
	floor?: number | string | null;
	floors?: number | string | null;
	building_year?: number | string | null;
	heat?: string | null;
	address?: string | null;
	lot_type?: string | null;
	balconies?: number | string | null;
	garden?: unknown;
	terraces?: number | string | null;
	bathroom_number?: number | string | null;
	shape?: string | null;
	location?: {
		path?: Array<{ name?: string | null; type?: string | null }>;
		short_name?: string | null;
	} | null;
	address_details?: {
		city?: string | null;
		street?: string | null;
		district?: string | null;
	} | null;
}

interface GhOffer {
	id?: string | null;
	slug?: string | null;
	name?: string | null;
	description?: string | null;
	deal_type?: string | null;
	market_type?: string | null;
	created_at?: string | null;
	offer_type?: string[] | null;
	investment_id?: string | number | null;
	is_private?: boolean | null;
	show_price?: boolean | null;
	price?: GhPrice | null;
	property?: GhProperty | null;
	coordinates?: {
		lat?: number | string | null;
		lon?: number | string | null;
	} | null;
	agency?: { name?: string | null } | null;
	pictures?: Array<Record<string, unknown>> | null;
}

interface GhState {
	offerList?: {
		offers?: {
			offers?: GhOffer[] | null;
			page?: number | string | null;
			pageCount?: number | string | null;
		} | null;
	} | null;
}

/** Extract the first balanced object assigned to `window.__INITIAL_STATE__`. */
function parseState(html: string): GhState | null {
	const marker = html.indexOf("window.__INITIAL_STATE__");
	if (marker < 0) return null;
	const eq = html.indexOf("=", marker);
	if (eq < 0) return null;
	const raw = html.slice(eq + 1).trimStart();
	const json = extractBalancedObject(raw);
	if (!json) return null;
	try {
		return JSON.parse(json) as GhState;
	} catch {
		return null;
	}
}

function extractBalancedObject(raw: string): string | null {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
		} else if (c === "{") {
			depth++;
		} else if (c === "}") {
			depth--;
			if (depth === 0) return raw.slice(0, i + 1);
		}
	}
	return null;
}

function offerUrl(slug: string | null): string | null {
	if (!slug) return null;
	return `${BASE}/oferta/${slug}/`;
}

function offerToListing(offer: GhOffer): Listing | null {
	if (offer.deal_type && offer.deal_type !== "sell") return null;
	const property = offer.property ?? {};
	const price = offer.price ?? {};
	const total = offer.show_price === false ? null : num(price.total);
	const perSqm = num(price.per_sqm);
	const areaM2 = num(property.size);
	const rooms = num(property.room_number);
	const floor = num(property.floor);
	const details = property.address_details ?? {};
	const city = str(details.city);
	const street = str(details.street);
	const district = str(details.district);
	const address =
		[street, district, city].filter(Boolean).join(", ") ||
		str(property.address) ||
		[district, city].filter(Boolean).join(", ") ||
		null;
	const propertyType = propertyTypeFromValue(property.type);
	const title =
		cleanText(str(offer.name)) ??
		[propertyType === "plot" ? "Działka" : "Nieruchomość", address]
			.filter(Boolean)
			.join(" ") ??
		"Nieruchomość na sprzedaż";
	const url = offerUrl(str(offer.slug));
	if (!url) return null;
	const externalId = str(offer.id) ?? url;

	const features: Record<string, unknown> = {
		market:
			str(offer.market_type) === "primary_market" ? "pierwotny" : "wtórny",
		offer_type: offer.offer_type ?? null,
		investment_id: offer.investment_id ?? null,
		is_private: offer.is_private ?? null,
		agency: offer.agency?.name ?? null,
		building_year: num(property.building_year),
		building_floors_num: num(property.floors),
		building_type: str(property.type),
		lot_type: str(property.lot_type),
		lot_size: num(property.lot_size),
		...(property.type === "lot" ? { plot_area: num(property.size) } : {}),
		...(num(property.balconies) != null
			? { balconies: num(property.balconies) }
			: {}),
		...(property.garden != null ? { garden: property.garden } : {}),
		...(num(property.terraces) != null
			? { terraces: num(property.terraces) }
			: {}),
		...(num(property.bathroom_number) != null
			? { bathrooms: num(property.bathroom_number) }
			: {}),
		...(property.shape ? { shape: property.shape } : {}),
		...(city ? { city } : {}),
		...(district ? { district } : {}),
		...(street ? { street } : {}),
		...(() => {
			const voivodeship = property.location?.path?.find(
				(entry) => entry.type?.toLowerCase() === "województwo",
			)?.name;
			return voivodeship ? { voivodeship } : {};
		})(),
		...(offer.pictures
			? {
					image_count: offer.pictures.length,
					primary_image:
						str(offer.pictures[0]?.o_img_500) ??
						str(offer.pictures[0]?.o_img_360x171),
				}
			: {}),
	};

	return {
		source: "gethome",
		externalId,
		url,
		title: title.slice(0, 240),
		price: total,
		pricePerM2: perSqm ?? (total && areaM2 ? total / areaM2 : null),
		areaM2,
		rooms,
		floor: floor !== null ? String(floor) : null,
		district,
		address,
		description: cleanText(str(offer.description))?.slice(0, 2000) ?? null,
		heatingType: cleanText(str(property.heat)),
		propertyType,
		features: JSON.stringify(features),
		lat: num(offer.coordinates?.lat),
		lng: num(offer.coordinates?.lon),
		listedAt: str(offer.created_at),
		scrapedAt: new Date().toISOString(),
	};
}

export const gethomeAdapter: CheerioAdapter = {
	id: "gethome",
	name: "GetHome - Małopolska + Śląsk real estate for sale",
	kind: "cheerio",
	startUrls: [
		...REGIONS.map((region) => `${BASE}/nieruchomosci/${region.name}/`),
		...REGIONS.map((region) => `${BASE}/dzialki/${region.name}/`),
	],
	maxRequestsPerCrawl: 500,
	firstPageOnlyRequests: REGIONS.length * 2,

	async extractHtml(html, url, enqueue) {
		const state = parseState(html);
		const page = state?.offerList?.offers;
		const offers = page?.offers ?? [];

		const listings: Listing[] = [];
		for (const offer of offers) {
			const listing = offerToListing(offer);
			if (listing) listings.push(listing);
		}

		const pageNumber = num(page?.page) ?? 1;
		const pageCount = num(page?.pageCount) ?? 0;
		const pageOnly = this.firstPageOnly === true && !this.alwaysFullCrawl;
		if (!pageOnly && pageCount > 0 && pageNumber < pageCount) {
			const next = new URL(url);
			next.searchParams.set("page", String(pageNumber + 1));
			await enqueue([next.href]);
		} else if (
			!pageOnly &&
			pageCount === 0 &&
			offers.length >= PAGE_SIZE_HINT
		) {
			// Defensive: a state without pageCount still paginates while the
			// page is full, so a markup change cannot silently stop the crawl.
			const next = new URL(url);
			next.searchParams.set("page", String(pageNumber + 1));
			await enqueue([next.href]);
		}

		return listings;
	},
};
