/**
 * Normalize the long tail of portal attributes into the handful of
 * queryable listing columns. Portals publish the same concepts under
 * different keys ("rent", "czynsz", "totalMaintenanceFee", "extras_types",
 * "amenityFeature", ...); adapters keep the raw blob in `listings.features`
 * and this module promotes the high-value intersection.
 *
 * Everything not promoted here stays in `features` (and is still available
 * to the UI through `parseListingFeatures`). The normalizer never guesses a
 * value: absent or ambiguous data returns null.
 */

export interface NormalizedListingAttributes {
	city: string | null;
	voivodeship: string | null;
	postalCode: string | null;
	street: string | null;
	streetNumber: string | null;
	plotAreaM2: number | null;
	plotType: string | null;
	buildingType: string | null;
	hasBalcony: boolean | null;
	hasTerrace: boolean | null;
	hasGarden: boolean | null;
	hasElevator: boolean | null;
	hasParking: boolean | null;
	hasGarage: boolean | null;
	hasBasement: boolean | null;
	isFurnished: boolean | null;
	petsAllowed: boolean | null;
	adminFee: number | null;
	deposit: number | null;
	priceNegotiable: boolean | null;
	priceOnRequest: boolean | null;
	advertiserType: string | null;
	agencyName: string | null;
	portalStatus: string | null;
	sourceUpdatedAt: Date | null;
	investmentId: string | null;
	investmentTitle: string | null;
	developer: string | null;
	auctionType: string | null;
	auctionDate: Date | null;
	wadium: number | null;
	seller: string | null;
}

const EMPTY: NormalizedListingAttributes = {
	city: null,
	voivodeship: null,
	postalCode: null,
	street: null,
	streetNumber: null,
	plotAreaM2: null,
	plotType: null,
	buildingType: null,
	hasBalcony: null,
	hasTerrace: null,
	hasGarden: null,
	hasElevator: null,
	hasParking: null,
	hasGarage: null,
	hasBasement: null,
	isFurnished: null,
	petsAllowed: null,
	adminFee: null,
	deposit: null,
	priceNegotiable: null,
	priceOnRequest: null,
	advertiserType: null,
	agencyName: null,
	portalStatus: null,
	sourceUpdatedAt: null,
	investmentId: null,
	investmentTitle: null,
	developer: null,
	auctionType: null,
	auctionDate: null,
	wadium: null,
	seller: null,
};

type Flat = Record<string, unknown>;

function normalizeKey(key: string): string {
	return key
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function flatten(value: unknown, out: Flat, prefix = ""): void {
	if (Array.isArray(value)) {
		out[prefix] = value;
		for (let i = 0; i < value.length; i++) {
			flatten(value[i], out, `${prefix}_${i}`);
		}
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value)) {
			flatten(entry, out, prefix ? `${prefix}_${key}` : key);
		}
		return;
	}
	out[prefix] = value;
}

function asString(value: unknown): string | null {
	if (typeof value === "string" && value.trim()) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return null;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const cleaned = value
		.replace(/\u00a0/g, " ")
		.replace(/[^\d,.-]/g, "")
		.replace(/\s/g, "")
		.replace(",", ".");
	const number = Number.parseFloat(cleaned);
	return Number.isFinite(number) ? number : null;
}

function asBool(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value > 0 ? true : null;
	if (typeof value !== "string") return null;
	const text = value.trim().toLowerCase();
	if (!text) return null;
	// "bez balkonu", "brak windy", "nie ma garażu": the feature word is
	// present but the value denies it.
	if (/(?:^|\W)(?:bez|brak|nie\s+ma)\s+/iu.test(text)) return false;
	if (
		/^(tak|yes|true|y|1)$/u.test(text) ||
		/(winda|lift|gara[żz]|garage|balkon|balcony|taras|terrace|ogr[oó]d|garden|piwnica|basement|parking|miejsce postojowe|umeblowane|furnished|zwierz[eę]ta)/iu.test(
			text,
		)
	) {
		return true;
	}
	if (/^(nie|nie\s+ma|no|false|n|0|brak|none)$/u.test(text)) return false;
	return null;
}

function asDate(value: unknown): Date | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 10_000_000_000 ? value : value * 1000;
		const date = new Date(ms);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	if (typeof value !== "string" || !value.trim()) return null;
	const text = value.trim();
	const iso = new Date(text.replace(" ", "T"));
	if (!Number.isNaN(iso.getTime())) return iso;
	const polish = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/u);
	if (polish) {
		const date = new Date(
			`${polish[3]}-${polish[2].padStart(2, "0")}-${polish[1].padStart(2, "0")}T00:00:00`,
		);
		return Number.isNaN(date.getTime()) ? null : date;
	}
	return null;
}

function flatMap(flat: Flat): Map<string, unknown> {
	const map = new Map<string, unknown>();
	for (const [key, value] of Object.entries(flat)) {
		map.set(normalizeKey(key), value);
	}
	return map;
}

function pick(map: Map<string, unknown>, aliases: string[]): unknown {
	for (const alias of aliases) {
		const value = map.get(normalizeKey(alias));
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

function pickString(
	map: Map<string, unknown>,
	aliases: string[],
): string | null {
	for (const alias of aliases) {
		const value = asString(map.get(normalizeKey(alias)));
		if (value) return value;
	}
	return null;
}

function pickNumber(
	map: Map<string, unknown>,
	aliases: string[],
): number | null {
	for (const alias of aliases) {
		const value = asNumber(map.get(normalizeKey(alias)));
		if (value !== null) return value;
	}
	return null;
}

function pickBool(
	map: Map<string, unknown>,
	aliases: string[],
): boolean | null {
	for (const alias of aliases) {
		const value = asBool(map.get(normalizeKey(alias)));
		if (value !== null) return value;
	}
	return null;
}

function asAreaM2(value: unknown, key: string): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 0 ? value : null;
	}
	if (typeof value !== "string" || !value.trim()) return null;
	const text = value.replace(/\u00a0/g, " ");
	const square = text.match(/([\d\s.,]+)\s*m[²2]/iu);
	if (square) return asNumber(square[1]);
	const hectares = text.match(/([\d\s.,]+)\s*ha\b/iu);
	if (hectares) {
		const hectaresValue = asNumber(hectares[1]);
		return hectaresValue === null ? null : hectaresValue * 10_000;
	}
	const ares = text.match(/([\d\s.,]+)\s*ar(?:ów|y|a)?\b/iu);
	if (ares) {
		const aresValue = asNumber(ares[1]);
		return aresValue === null ? null : aresValue * 100;
	}
	const number = asNumber(text);
	if (number === null) return null;
	if (/(?:^|_)ha(?:$|_)/iu.test(key)) return number * 10_000;
	if (/(?:^|_)ar(?:$|_)/iu.test(key)) return number * 100;
	return number;
}

function factsText(flat: Flat): string {
	return Object.entries(flat)
		.filter(
			([key]) =>
				/amenit|feature|extra|equip|wyposaz|udogodn|attributes/iu.test(key) &&
				!/name$|url|image/iu.test(key),
		)
		.map(([, value]) => {
			if (typeof value === "string") return value;
			if (Array.isArray(value)) {
				return value
					.map((entry) => (typeof entry === "string" ? entry : ""))
					.join(" ");
			}
			return "";
		})
		.join(" ")
		.toLowerCase();
}

function hasFeature(
	map: Map<string, unknown>,
	facts: string,
	aliases: string[],
	terms: string[],
): boolean | null {
	const explicit = pickBool(map, aliases);
	if (explicit !== null) return explicit;
	return factsFeatureState(facts, terms);
}

/**
 * Feature text match: true on a positive mention, false when every mention
 * is negated ("brak windy"), null when the terms never appear.
 */
function factsFeatureState(facts: string, terms: string[]): boolean | null {
	let sawNegated = false;
	for (const term of terms) {
		let from = 0;
		while (from <= facts.length) {
			const index = facts.indexOf(term, from);
			if (index < 0) break;
			const before = facts.slice(Math.max(0, index - 24), index);
			if (/(?:^|\W)(?:bez|brak|nie\s+ma)\s*$/iu.test(before)) {
				sawNegated = true;
			} else {
				return true;
			}
			from = index + term.length;
		}
	}
	return sawNegated ? false : null;
}

function splitStreet(value: string): {
	street: string;
	number: string | null;
} {
	const match = value.match(/^(.*?)[\s,]+(\d+[a-zA-Z]?(?:\/\d+)?)$/u);
	if (!match) return { street: value, number: null };
	return { street: match[1].trim(), number: match[2] };
}

function normalizePlotType(value: string | null): string | null {
	if (!value) return null;
	const text = value.toLowerCase();
	if (/budow/iu.test(text)) return "budowlana";
	if (/roln/iu.test(text)) return "rolna";
	if (/rekreac/iu.test(text)) return "rekreacyjna";
	if (/siedlisk/iu.test(text)) return "siedliskowa";
	if (/le[śs]/iu.test(text)) return "leśna";
	if (/inwestycy/iu.test(text)) return "inwestycyjna";
	return text.slice(0, 40);
}

function normalizeBuildingType(value: string | null): string | null {
	if (!value) return null;
	const text = value.toLowerCase();
	if (/blok|block|wielorodzin/iu.test(text)) return "block";
	if (/apartamentowiec|apartment/iu.test(text)) return "apartment";
	if (/kamienic|tenement/iu.test(text)) return "tenement";
	if (/bli[źz]niak|semi/iu.test(text)) return "semi_detached";
	if (/szereg|townhouse|terrace/iu.test(text)) return "townhouse";
	if (/wolnostoj|detached|jednorodzin/iu.test(text)) return "detached";
	if (/dom|house/iu.test(text)) return "house";
	return text.slice(0, 40);
}

function normalizeAdvertiserType(map: Map<string, unknown>): string | null {
	const raw = pickString(map, [
		"advertiser_type",
		"advertisertype",
		"seller_type",
		"sellertype",
		"user_type",
		"usertype",
		"offer_from",
	]);
	if (raw) {
		const text = raw.toLowerCase();
		if (/deweloper|developer/iu.test(text)) return "developer";
		if (/agenc|biuro|agency|business|firma/iu.test(text)) return "agency";
		if (/prywat|private|person|osoba/iu.test(text)) return "private";
	}
	if (pickBool(map, ["is_private", "isprivate", "private"]) === true) {
		return "private";
	}
	if (pickBool(map, ["is_business", "isbusiness", "business"]) === true) {
		return "agency";
	}
	return null;
}

function normalizeAgencyName(map: Map<string, unknown>): string | null {
	const direct = pickString(map, [
		"agency_name",
		"agencyname",
		"agency",
		"biuro_nieruchomosci",
	]);
	if (direct) return direct;
	const sellerType = pickString(map, ["seller_type", "sellertype"]);
	if (
		sellerType &&
		/agenc|organization|realestateagent|biuro/iu.test(sellerType)
	) {
		return pickString(map, ["seller_name", "sellername"]);
	}
	return null;
}

function normalizePortalStatus(map: Map<string, unknown>): string | null {
	const raw = pickString(map, [
		"portal_status",
		"portalstatus",
		"ad_status",
		"adstatus",
		"status",
	]);
	if (!raw) return null;
	const text = raw.toLowerCase();
	if (/active|aktywn|published|opublik/iu.test(text)) return "active";
	if (/reserved|zarezerw|hold/iu.test(text)) return "reserved";
	if (/sold|sprzedan/iu.test(text)) return "sold";
	if (/expired|wygas|archiw/iu.test(text)) return "expired";
	return text.slice(0, 40);
}

export function normalizeListingAttributes(
	features: string | null,
): NormalizedListingAttributes {
	if (!features) return EMPTY;
	let parsed: unknown;
	try {
		parsed = JSON.parse(features);
	} catch {
		return EMPTY;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return EMPTY;
	}
	const flat: Flat = {};
	flatten(parsed, flat);
	const map = flatMap(flat);
	const facts = factsText(flat);

	const rawStreet =
		pickString(map, [
			"street",
			"street_name",
			"streetname",
			"address_street",
			"address_street_name",
			"address_streetaddress",
			"ulica",
		]) ?? null;
	const explicitNumber = pickString(map, [
		"address_street_number",
		"street_number",
		"streetnumber",
		"building_no",
		"buildingno",
		"numer",
	]);
	const split = rawStreet ? splitStreet(rawStreet) : null;

	const plotRaw = pick(map, [
		"plot_area",
		"plot_area_m2",
		"plotaream2",
		"lot_size",
		"lotsize",
		"land_area",
		"landarea",
		"terrain_area",
		"terrainarea",
		"powierzchnia_dzialki",
		"powierzchnia_gruntu",
	]);
	const plotAreaM2 =
		plotRaw !== undefined && plotRaw !== null
			? asAreaM2(plotRaw, "plot_area")
			: null;

	const priceType = pickString(map, ["price_type", "pricetype"]);
	const priceOnRequestExplicit =
		pickBool(map, [
			"on_request",
			"onrequest",
			"price_on_request",
			"priceonrequest",
			"hide_price",
			"hideprice",
		]) ??
		(priceType && /request|hidden|on_request/iu.test(priceType) ? true : null);

	return {
		city: pickString(map, [
			"city",
			"city_name",
			"cityname",
			"address_city",
			"address_locality",
			"addresslocality",
			"location_cityname",
			"miejscowosc",
		]),
		voivodeship: pickString(map, [
			"voivodeship",
			"province",
			"address_region",
			"addressregion",
			"location_regionname",
			"wojewodztwo",
		]),
		postalCode: pickString(map, [
			"postal_code",
			"postalcode",
			"zip",
			"zip_code",
			"zipcode",
			"kod_pocztowy",
		]),
		street: split?.street ?? rawStreet,
		streetNumber: explicitNumber ?? split?.number ?? null,
		plotAreaM2: plotAreaM2 !== null && plotAreaM2 > 0 ? plotAreaM2 : null,
		plotType: normalizePlotType(
			pickString(map, [
				"plot_type",
				"plottype",
				"lot_type",
				"lottype",
				"land_type",
				"landtype",
				"typ_nieruchomosci",
			]),
		),
		buildingType: normalizeBuildingType(
			pickString(map, [
				"building_type",
				"buildingtype",
				"builttype",
				"rodzaj_zabudowy",
				"zabudowa",
			]),
		),
		hasBalcony: hasFeature(
			map,
			facts,
			["balcony", "balconies", "has_balcony", "balkon"],
			["balkon", "balcony"],
		),
		hasTerrace: hasFeature(
			map,
			facts,
			["terrace", "terraces", "has_terrace", "taras"],
			["taras", "terrace"],
		),
		hasGarden: hasFeature(
			map,
			facts,
			["garden", "has_garden", "ogrod", "ogrodek"],
			["ogród", "ogrod", "garden", "ogródek", "ogrodek"],
		),
		hasElevator: hasFeature(
			map,
			facts,
			["lift", "elevator", "has_elevator", "winda"],
			["winda", "windy", "wind", "lift", "elevator"],
		),
		hasParking: hasFeature(
			map,
			facts,
			["parking", "has_parking", "miejsce_postojowe"],
			["parking", "miejsce postojowe", "postojow"],
		),
		hasGarage: hasFeature(
			map,
			facts,
			["garage", "garaz", "has_garage"],
			["garaż", "garaz", "garage"],
		),
		hasBasement: hasFeature(
			map,
			facts,
			["basement", "piwnica", "has_basement"],
			["piwnic", "basement"],
		),
		isFurnished: pickBool(map, [
			"furniture",
			"furnished",
			"umeblowane",
			"is_furnished",
		]),
		petsAllowed: pickBool(map, [
			"pets",
			"pets_allowed",
			"petsallowed",
			"zwierzeta",
			"zwierzęta",
		]),
		adminFee: pickNumber(map, [
			"admin_fee",
			"adminfee",
			"rent",
			"maintenance_fee",
			"maintenancefee",
			"total_maintenance_fee",
			"totalmaintenancefee",
			"czynsz",
			"oplata_administracyjna",
		]),
		deposit: pickNumber(map, ["deposit", "kaucja"]),
		priceNegotiable: pickBool(map, [
			"negotiable",
			"price_negotiable",
			"pricenegotiable",
			"do_negocjacji",
			"negocjowalna",
		]),
		priceOnRequest: priceOnRequestExplicit,
		advertiserType: normalizeAdvertiserType(map),
		agencyName: normalizeAgencyName(map),
		portalStatus: normalizePortalStatus(map),
		sourceUpdatedAt: asDate(
			pick(map, [
				"source_updated_at",
				"sourceupdatedat",
				"modified_at",
				"modifiedat",
				"updated_at",
				"updatedat",
				"last_refresh_time",
				"lastrefreshtime",
				"last_refresh_at",
			]),
		),
		investmentId: pickString(map, [
			"investment_id",
			"investmentid",
			"development_id",
			"developmentid",
		]),
		investmentTitle: pickString(map, [
			"investment_title",
			"investmenttitle",
			"development_title",
			"developmenttitle",
		]),
		developer: pickString(map, [
			"developer",
			"developer_name",
			"developername",
			"brand_name",
			"brandname",
		]),
		auctionType: pickString(map, [
			"auction_type",
			"auctiontype",
			"auction_label",
		]),
		auctionDate: asDate(
			pick(map, [
				"auction_date",
				"auctiondate",
				"termin_przetargu",
				"termin_skladania_ofert",
				"termin_licytacji",
			]),
		),
		wadium: pickNumber(map, ["wadium"]),
		seller: pickString(map, [
			"seller",
			"seller_name",
			"sellername",
			"sprzedajacy",
			"organ_egzekucyjny",
			"auction_seller",
		]),
	};
}
