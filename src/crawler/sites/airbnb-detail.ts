/**
 * Airbnb room (detail) page parsing: the `data-deferred-state-0` script
 * carries `niobeClientData[0][1].data.node` with structured PDP data
 * (overview items "2 gości / 1 sypialnia / 1 łóżko / 1 łazienka",
 * amenity groups, long description, precise-ish coordinates).
 *
 * No price without dates in the anonymous payload; nightly price stays
 * owned by the search page.
 */
export interface RoomDetails {
	/** Listing name from title/description (UGC). */
	name: string | null;
	/** e.g. "Cały obiekt – apartament w: Kraków, Polska". */
	overviewTitle: string | null;
	maxGuests: number | null;
	bedrooms: number | null;
	beds: number | null;
	bathrooms: number | null;
	propertyType: string | null;
	spaceType: string | null;
	rating: number | null;
	reviewsCount: number | null;
	lat: number | null;
	lng: number | null;
	isExactLocation: boolean | null;
	locationSubtitle: string | null;
	descriptionShort: string | null;
	descriptionLong: string | null;
	amenities: string[];
	highlights: string[];
}

function findNiobeNode(html: string): Record<string, unknown> | null {
	const m = html.match(
		/<script id="data-deferred-state-0"[^>]*>([\s\S]*?)<\/script>/,
	);
	if (!m) return null;
	let raw = m[1];
	if (raw.startsWith("%")) {
		try {
			raw = decodeURIComponent(raw);
		} catch {
			return null;
		}
	}
	try {
		const data = JSON.parse(raw) as {
			niobeClientData?: Array<[string, { data?: { node?: unknown } }]>;
		};
		const entry = data.niobeClientData?.find(([, v]) => v?.data?.node);
		return (entry?.[1]?.data?.node as Record<string, unknown>) ?? null;
	} catch {
		return null;
	}
}

function localizedString(v: unknown): string | null {
	if (!v || typeof v !== "object") return null;
	const rec = v as Record<string, unknown>;
	const s = rec.localizedStringWithTranslationPreference ?? rec.localizedString;
	return typeof s === "string" ? s : null;
}

function ugcText(v: unknown): string | null {
	if (!v || typeof v !== "object") return null;
	const rec = v as Record<string, unknown>;
	const content = rec.content ?? rec;
	return localizedString(content);
}

/** Parse "2 gości", "1 sypialnia", "1 łóżko", "1 łazienka", "1,5 łazienki". */
function parseOverviewItems(items: unknown[]): Partial<RoomDetails> {
	const out: Partial<RoomDetails> = {};
	for (const item of items) {
		if (typeof item !== "string") continue;
		const m = item.match(/^([\d.,]+)\s*(.+)/);
		if (!m) continue;
		const n = Number(m[1].replace(",", "."));
		if (!Number.isFinite(n)) continue;
		const unit = m[2].toLowerCase();
		if (/gość|gości/.test(unit)) out.maxGuests = n;
		else if (/sypialn/.test(unit)) out.bedrooms = n;
		else if (/łóżk/.test(unit)) out.beds = n;
		else if (/łazienk/.test(unit)) out.bathrooms = n;
	}
	return out;
}

function collectAmenityTitles(node: unknown, acc: string[]): void {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const v of node) collectAmenityTitles(v, acc);
		return;
	}
	const rec = node as Record<string, unknown>;
	if (rec.__typename === "AmenityItem" && typeof rec.title === "string") {
		acc.push(rec.title);
		return;
	}
	for (const v of Object.values(rec)) collectAmenityTitles(v, acc);
}

export function parseRoomHtml(html: string): RoomDetails | null {
	const node = findNiobeNode(html);
	if (!node) return null;

	const pdp = node.pdpPresentation as Record<string, unknown> | undefined;
	const ratingStats = node.listingRatingStats as
		| Record<string, unknown>
		| undefined;
	const overall = ratingStats?.overallRatingStats as
		| Record<string, unknown>
		| undefined;

	const details: RoomDetails = {
		name:
			ugcText(pdp?.title) ??
			localizedString(
				(node.description as Record<string, unknown> | undefined)?.name,
			),
		overviewTitle: null,
		maxGuests:
			typeof node.personCapacity === "number" ? node.personCapacity : null,
		bedrooms: null,
		beds: null,
		bathrooms: null,
		propertyType:
			typeof node.propertyType === "string"
				? node.propertyType.toLowerCase()
				: null,
		spaceType:
			typeof node.spaceType === "string" ? node.spaceType.toLowerCase() : null,
		rating:
			typeof overall?.ratingAverage === "number"
				? overall.ratingAverage
				: typeof overall?.ratingAverage === "string"
					? Number(overall.ratingAverage)
					: null,
		reviewsCount:
			overall?.ratingCount != null ? Number(overall.ratingCount) : null,
		lat: null,
		lng: null,
		isExactLocation: null,
		locationSubtitle: null,
		descriptionShort: null,
		descriptionLong: null,
		amenities: [],
		highlights: [],
	};
	details.rating =
		details.rating != null && Number.isFinite(details.rating)
			? details.rating
			: null;
	details.reviewsCount =
		details.reviewsCount != null && Number.isFinite(details.reviewsCount)
			? details.reviewsCount
			: null;
	// A listing with zero reviews has no meaningful score.
	if (details.reviewsCount === 0) details.rating = null;

	if (pdp) {
		const overview = pdp.overview as Record<string, unknown> | undefined;
		if (typeof overview?.title === "string")
			details.overviewTitle = overview.title;
		const items = overview?.items;
		if (Array.isArray(items)) Object.assign(details, parseOverviewItems(items));

		const location = pdp.location as Record<string, unknown> | undefined;
		if (location) {
			if (typeof location.latitude === "number")
				details.lat = location.latitude;
			if (typeof location.longitude === "number")
				details.lng = location.longitude;
			if (typeof location.isExactLocation === "boolean")
				details.isExactLocation = location.isExactLocation;
			if (typeof location.subtitle === "string")
				details.locationSubtitle = location.subtitle;
		}

		const descriptions = pdp.descriptions as
			| Record<string, unknown>
			| undefined;
		if (descriptions) {
			details.descriptionShort =
				localizedString(descriptions.shortDescriptionHtml) ??
				localizedString(descriptions.longDescriptionHtml);
		}

		const amenities: string[] = [];
		collectAmenityTitles(pdp.amenities, amenities);
		details.amenities = [...new Set(amenities)];

		const highlights = Array.isArray(pdp.highlights) ? pdp.highlights : [];
		details.highlights = highlights
			.map((h) => (h && typeof h === "object" ? localizedString(h) : null))
			.filter((h): h is string => h != null);
	}

	// Long description lives on node.description (UGCText) when present.
	const desc = ugcText(node.description);
	if (desc) details.descriptionLong = desc;

	return details;
}
