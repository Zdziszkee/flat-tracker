import {
	dateLabel,
	formatPln,
	formatUtilities,
	realizationCaption,
	yearOf,
} from "#/lib/format";
import { escapeHtml } from "#/lib/html";
import { parseListingFeatures } from "#/lib/listing-features";
import { PROPERTY_KIND_LABELS } from "#/lib/property-kind";
import { sourceLabel } from "#/lib/sources";
import type { ListingAttributesDto, OfferValuation } from "#/types/listing";
import type { ApiListing, BuildingLookup } from "./types";

const BUILDING_TYPE_LABELS: Record<string, string> = {
	block: "blok",
	apartment: "apartamentowiec",
	tenement: "kamienica",
	semi_detached: "bliźniak",
	townhouse: "szeregowiec",
	detached: "wolnostojący",
	house: "dom",
};

const MARKET_LABELS: Record<string, string> = {
	primary: "pierwotny",
	secondary: "wtórny",
	pierwotny: "pierwotny",
	wtórny: "wtórny",
};

const CONDITION_LABELS: Record<string, string> = {
	good: "dobry",
	very_good: "bardzo dobry",
	excellent: "bardzo dobry",
	to_renovation: "do remontu",
	renovation: "do remontu",
	for_renovation: "do remontu",
	to_completion: "do wykończenia",
	not_good: "do remontu",
	poor: "do remontu",
	new: "nowy",
};

const HEATING_LABELS: Record<string, string> = {
	urban: "miejskie",
	district: "miejskie",
	gas: "gazowe",
	electric: "elektryczne",
	electricity: "elektryczne",
	oil: "olejowe",
	solid_fuel: "na paliwo stałe",
	coal: "węglowe",
	wood: "na drewno",
	heat_pump: "pompa ciepła",
};

const MATERIAL_LABELS: Record<string, string> = {
	concrete: "żelbet",
	reinforced_concrete: "żelbet",
	brick: "cegła",
	ceramic: "ceramika",
	wood: "drewno",
	steel: "stal",
	silicate: "silikat",
	aerated_concrete: "beton komórkowy",
};

const OWNERSHIP_LABELS: Record<string, string> = {
	full_ownership: "własność",
	cooperative: "spółdzielcze",
	leasehold: "użytkowanie wieczyste",
	share: "udział",
};

const OFFER_TYPE_LABELS: Record<string, string> = {
	sale: "sprzedaż",
	long_term_rental: "wynajem",
	short_term_rental: "krótki termin",
};

const AUCTION_TYPE_LABELS: Record<string, string> = {
	amw: "AMW",
	kowr: "KOWR",
	skarbowe: "Skarb Państwa",
	gminne: "gmina",
	pkp: "PKP",
	orange: "Orange",
	tauron: "Tauron",
	licytacja: "licytacja",
	przetarg: "przetarg",
};

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
	reserved: {
		label: "Zarezerwowane",
		className: "bg-amber-100 text-amber-800",
	},
	sold: { label: "Sprzedane", className: "bg-gray-200 text-gray-700" },
	expired: { label: "Wygasłe", className: "bg-gray-200 text-gray-500" },
};

function humanizeLabel(value: string): string {
	const text = value.replace(/[_-]+/gu, " ").trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function mappedLabel(
	map: Record<string, string>,
	value: string | null | undefined,
): string | null {
	if (!value) return null;
	return map[value.toLowerCase()] ?? humanizeLabel(value);
}

function floorLabel(value: string): string {
	const text = value.toLowerCase().trim();
	if (text === "ground_floor" || text === "parter") return "parter";
	if (text === "basement") return "suterena";
	if (text === "garage") return "garaż";
	if (text === "roof") return "poddasze";
	const match = text.match(/^floor_(-?\d+)$/u);
	if (!match) return value;
	const number = Number.parseInt(match[1], 10);
	if (number === 0) return "parter";
	return number < 0 ? "suterena" : match[1];
}

function formatArea(value: number): string {
	return `${value.toLocaleString("pl-PL", { maximumFractionDigits: 1 })} m²`;
}

function rawText(raw: Record<string, unknown>, keys: string[]): string | null {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) {
			return String(value);
		}
	}
	return null;
}

function rawNumber(
	raw: Record<string, unknown>,
	keys: string[],
): number | null {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "string") continue;
		const parsed = Number.parseFloat(
			value
				.replace(/\u00a0/g, " ")
				.replace(/\s/g, "")
				.replace(",", "."),
		);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function rawBool(raw: Record<string, unknown>, keys: string[]): boolean | null {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "boolean") return value;
		if (typeof value === "number") return value > 0;
		if (typeof value !== "string") continue;
		const text = value.trim().toLowerCase();
		if (/^(tak|yes|true|1)$/u.test(text)) return true;
		if (/^(nie|no|false|0|brak)$/u.test(text)) return false;
	}
	return null;
}

/**
 * Amenity fallback for rows crawled before the promoted columns existed.
 * The server sends normalized `attributes` for new rows; this reads the
 * common raw feature arrays of the older payloads.
 */
function rawFeature(
	raw: Record<string, unknown>,
	keys: string[],
	terms: string[],
): boolean | null {
	const direct = rawBool(raw, keys);
	if (direct !== null) return direct;
	for (const key of [
		"amenities",
		"extras_types",
		"udogodnienia",
		"equipment",
		"wyposazenie",
		"amenityFeature",
		"additionalProperty",
	]) {
		const list = raw[key];
		if (!Array.isArray(list)) continue;
		const text = list
			.map((entry) => {
				if (typeof entry === "string") return entry;
				if (entry && typeof entry === "object") {
					const record = entry as Record<string, unknown>;
					return `${record.name ?? ""} ${record.value ?? ""}`;
				}
				return "";
			})
			.join(" ")
			.toLowerCase();
		if (/(?:^|\W)(?:bez|brak|nie\s+ma)\s+/u.test(text)) {
			const positive = terms.some(
				(term) =>
					text.includes(term) &&
					!text.includes(`brak ${term}`) &&
					!text.includes(`bez ${term}`),
			);
			if (positive) return true;
			continue;
		}
		if (terms.some((term) => text.includes(term))) return true;
	}
	return null;
}

function fallbackAttributes(
	raw: Record<string, unknown>,
): Partial<ListingAttributesDto> {
	return {
		city:
			rawText(raw, ["city", "city_name", "address_city", "address_locality"]) ??
			undefined,
		street:
			rawText(raw, ["street", "street_name", "address_street"]) ?? undefined,
		streetNumber: rawText(raw, ["street_number", "building_no"]) ?? undefined,
		postalCode: rawText(raw, ["postal_code", "postalCode", "zip"]) ?? undefined,
		plotAreaM2:
			rawNumber(raw, [
				"plot_area",
				"plot_area_m2",
				"lot_size",
				"powierzchnia_dzialki",
			]) ?? undefined,
		plotType: rawText(raw, ["plot_type", "lot_type"]) ?? undefined,
		buildingType:
			rawText(raw, ["building_type", "buildingType", "builttype"]) ?? undefined,
		market: rawText(raw, ["market", "rynek"]) ?? undefined,
		buildYear:
			rawNumber(raw, ["build_year", "year_built", "rok_budowy"]) ?? undefined,
		buildingMaterial:
			rawText(raw, ["building_material", "buildingMaterial", "material"]) ??
			undefined,
		floorCount:
			rawNumber(raw, ["floors_num", "floor_count", "building_floors_num"]) ??
			undefined,
		condition: rawText(raw, ["condition", "stan"]) ?? undefined,
		ownership: rawText(raw, ["ownership"]) ?? undefined,
		hasBalcony:
			rawFeature(
				raw,
				["balcony", "has_balcony", "balkon"],
				["balkon", "balcony"],
			) ?? undefined,
		hasTerrace:
			rawFeature(
				raw,
				["terrace", "has_terrace", "taras"],
				["taras", "terrace"],
			) ?? undefined,
		hasGarden:
			rawFeature(
				raw,
				["garden", "has_garden", "ogrod", "ogrodek"],
				["ogród", "ogrod", "garden"],
			) ?? undefined,
		hasElevator:
			rawFeature(
				raw,
				["lift", "elevator", "has_elevator", "winda"],
				["winda", "wind", "lift", "elevator"],
			) ?? undefined,
		hasParking:
			rawFeature(raw, ["parking", "has_parking"], ["parking", "postojow"]) ??
			undefined,
		hasGarage:
			rawFeature(
				raw,
				["garage", "garaz", "has_garage"],
				["garaż", "garaz", "garage"],
			) ?? undefined,
		hasBasement:
			rawFeature(
				raw,
				["basement", "piwnica", "has_basement"],
				["piwnic", "basement"],
			) ?? undefined,
		isFurnished:
			rawBool(raw, ["furniture", "furnished", "umeblowane"]) ?? undefined,
		petsAllowed:
			rawBool(raw, ["pets", "pets_allowed", "zwierzeta"]) ?? undefined,
		adminFee:
			rawNumber(raw, [
				"total_maintenance_fee",
				"admin_fee",
				"czynsz",
				"rent",
			]) ?? undefined,
		deposit: rawNumber(raw, ["deposit", "kaucja"]) ?? undefined,
		priceNegotiable:
			rawBool(raw, ["price_negotiable", "negotiable"]) ?? undefined,
		priceOnRequest:
			rawBool(raw, ["price_on_request", "on_request"]) ?? undefined,
		advertiserType:
			rawText(raw, ["advertiser_type", "seller_type", "user_type"]) ??
			undefined,
		agencyName: rawText(raw, ["agency", "agency_name"]) ?? undefined,
		portalStatus: rawText(raw, ["portal_status", "status"]) ?? undefined,
		sourceUpdatedAt:
			rawText(raw, [
				"source_updated_at",
				"modified_at",
				"updated_at",
				"last_refresh_time",
			]) ?? undefined,
		investmentTitle:
			rawText(raw, ["investment_title", "development_title"]) ?? undefined,
		developer: rawText(raw, ["developer", "developer_name"]) ?? undefined,
		auctionType: rawText(raw, ["auction_type", "auction_label"]) ?? undefined,
		auctionDate:
			rawText(raw, ["auction_date", "termin_licytacji"]) ?? undefined,
		wadium: rawNumber(raw, ["wadium"]) ?? undefined,
		seller:
			rawText(raw, ["seller", "organ_egzekucyjny", "sprzedajacy"]) ?? undefined,
	};
}

export function popupHtml(listing: ApiListing): string {
	const stats = listing.transactionStats;
	const features = parseListingFeatures(listing.features);
	const attributes = {
		...fallbackAttributes(features.raw),
		...listing.attributes,
	};
	const minYear = yearOf(stats?.txMinDate);
	const maxYear = yearOf(stats?.txMaxDate);
	const range = minYear && maxYear ? ` (${minYear}-${maxYear})` : "";
	const added = listing.listedAt ?? listing.firstSeenAt;
	const addedLabel = added
		? new Date(added).toLocaleDateString("pl-PL")
		: "n/d";
	const streetLine = attributes.street
		? `${attributes.street}${
				attributes.streetNumber ? ` ${attributes.streetNumber}` : ""
			}`
		: null;
	const cityLine = [attributes.postalCode, attributes.city]
		.filter(Boolean)
		.join(" ");
	const structuredLocation = [streetLine, cityLine].filter(Boolean).join(", ");
	const location =
		listing.address ??
		(structuredLocation || listing.district || listing.buildingAddress || "");

	// Physical layout: portal columns first, then Airbnb PDP extraction.
	// bedrooms wins over rooms so short-term rentals show sypialnie.
	const layoutParts: string[] = [];
	if (listing.areaM2) layoutParts.push(formatArea(listing.areaM2));
	if (listing.rooms && listing.bedrooms == null)
		layoutParts.push(`${listing.rooms} pok.`);
	if (listing.bedrooms != null)
		layoutParts.push(
			listing.bedrooms === 0
				? "kawalerka"
				: `${listing.bedrooms} sypialn${listing.bedrooms === 1 ? "ia" : "ie"}`,
		);
	if (listing.beds != null)
		layoutParts.push(`${listing.beds} łóż${listing.beds === 1 ? "ko" : "ka"}`);
	if (listing.bathrooms != null)
		layoutParts.push(
			`${String(listing.bathrooms).replace(".", ",")} łazienk${listing.bathrooms === 1 ? "a" : "i"}`,
		);
	if (listing.maxGuests != null)
		layoutParts.push(`do ${listing.maxGuests} gości`);
	if (listing.floor) {
		const floor = floorLabel(listing.floor);
		layoutParts.push(floor === "parter" ? floor : `piętro ${floor}`);
	}
	if (attributes.plotAreaM2) {
		const plot = attributes.plotType
			? `działka ${attributes.plotType}`
			: "działka";
		layoutParts.push(`${plot} ${formatArea(attributes.plotAreaM2)}`);
	}
	const details = layoutParts.join(" · ");

	const utilities = formatUtilities(listing.utilities);

	// Parameter grid: only the facts the portal actually published.
	const facts: Array<[string, string]> = [];
	const offerLabel = mappedLabel(OFFER_TYPE_LABELS, listing.offerType);
	if (offerLabel) facts.push(["Oferta", humanizeLabel(offerLabel)]);
	const kindLabel = listing.propertyKind
		? PROPERTY_KIND_LABELS[listing.propertyKind]
		: listing.propertyType
			? (PROPERTY_KIND_LABELS[
					listing.propertyType as keyof typeof PROPERTY_KIND_LABELS
				] ?? humanizeLabel(listing.propertyType))
			: null;
	if (kindLabel) facts.push(["Typ", kindLabel]);
	const marketLabel = mappedLabel(MARKET_LABELS, attributes.market);
	if (marketLabel) facts.push(["Rynek", marketLabel]);
	if (attributes.buildYear) {
		const currentYear = new Date().getFullYear();
		const age = currentYear - attributes.buildYear;
		facts.push([
			"Rok budowy",
			age > 0
				? `${attributes.buildYear} (${ageLabel(attributes.buildYear)})`
				: String(attributes.buildYear),
		]);
	}
	const material = mappedLabel(MATERIAL_LABELS, attributes.buildingMaterial);
	if (material) facts.push(["Materiał", material]);
	if (attributes.buildingType) {
		const buildingType = mappedLabel(
			BUILDING_TYPE_LABELS,
			attributes.buildingType,
		);
		if (buildingType) facts.push(["Budynek", buildingType]);
	}
	if (attributes.floorCount)
		facts.push(["Kondygnacje", String(attributes.floorCount)]);
	const condition = mappedLabel(CONDITION_LABELS, attributes.condition);
	if (condition) facts.push(["Stan", condition]);
	const ownership = mappedLabel(OWNERSHIP_LABELS, attributes.ownership);
	if (ownership) facts.push(["Forma własności", ownership]);
	const heating = mappedLabel(HEATING_LABELS, listing.heatingType);
	if (heating) facts.push(["Ogrzewanie", heating]);
	const advertiserBase =
		attributes.advertiserType === "private"
			? "Oferta prywatna"
			: attributes.advertiserType === "agency"
				? "Biuro nieruchomości"
				: attributes.advertiserType === "developer"
					? "Deweloper"
					: mappedLabel({}, attributes.advertiserType);
	const advertiser =
		advertiserBase && attributes.agencyName
			? `${advertiserBase}: ${attributes.agencyName}`
			: (advertiserBase ?? attributes.agencyName);
	if (advertiser) facts.push(["Oferujący", advertiser]);
	if (
		attributes.investmentTitle &&
		!listing.title
			.toLowerCase()
			.includes(attributes.investmentTitle.toLowerCase())
	) {
		facts.push(["Inwestycja", attributes.investmentTitle]);
	}
	if (attributes.developer) facts.push(["Deweloper", attributes.developer]);
	const factsHtml =
		facts.length > 0
			? `<div class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t pt-1 text-xs">
				${facts
					.map(
						([label, value]) =>
							`<span class="text-gray-400">${escapeHtml(label)}</span><span class="break-words text-gray-700">${escapeHtml(value)}</span>`,
					)
					.join("")}
			</div>`
			: "";

	// Rental cost breakdown and auction terms, when the portal published them.
	const costParts: string[] = [];
	if (attributes.adminFee)
		costParts.push(`Czynsz: ${formatPln(attributes.adminFee)}/mc`);
	if (attributes.deposit)
		costParts.push(`Kaucja: ${formatPln(attributes.deposit)}`);
	const costs = costParts.join(" · ");
	let auctionHtml = "";
	const auctionDate = attributes.auctionDate
		? new Date(attributes.auctionDate).toLocaleDateString("pl-PL")
		: null;
	const auctionLabel = mappedLabel(AUCTION_TYPE_LABELS, attributes.auctionType);
	if (auctionLabel || auctionDate || attributes.wadium || attributes.seller) {
		const auctionHead = [auctionLabel, auctionDate].filter(Boolean).join(" · ");
		const auctionMeta = [
			attributes.wadium ? `Wadium: ${formatPln(attributes.wadium)}` : null,
			attributes.seller ? `Organizator: ${attributes.seller}` : null,
		]
			.filter(Boolean)
			.join(" · ");
		auctionHtml = `<div class="border-t pt-1 text-xs text-purple-800">
			<div class="font-medium">Aukcja / przetarg</div>
			${auctionHead ? `<div>${escapeHtml(auctionHead)}</div>` : ""}
			${auctionMeta ? `<div class="text-gray-600">${escapeHtml(auctionMeta)}</div>` : ""}
		</div>`;
	}

	const statusBadge = attributes.portalStatus
		? STATUS_BADGES[attributes.portalStatus.toLowerCase()]
		: null;

	const priceText = attributes.priceOnRequest
		? "Cena na zapytanie"
		: formatPln(listing.price);

	// Forum-sourced investments are construction threads, not offers: no
	// price row, show thread activity instead of a valuation. Investmap
	// investment-level rows (`inv-`) are the same kind of inventory.
	const isBudujesie = listing.source === "budujesie";
	const isInvestmentRow =
		listing.source === "investmap" && listing.externalId.startsWith("inv-");
	let threadStats = "";
	// A forum topic is not proof the building is still under construction:
	// the site carries no status field, so the label claims "w budowie" only
	// while the thread is alive (posts within 18 months).
	let budLabel = "Inwestycja";
	const budujesie = features.budujesie;
	if (isBudujesie && budujesie) {
		const parts: string[] = [];
		if (typeof budujesie.replies === "number")
			parts.push(`${budujesie.replies} odp.`);
		if (typeof budujesie.views === "number")
			parts.push(`${budujesie.views.toLocaleString("pl-PL")} wyśw.`);
		threadStats = parts.join(" · ");
		const last = budujesie.lastPostAt ? new Date(budujesie.lastPostAt) : null;
		const fresh =
			last != null &&
			!Number.isNaN(last.getTime()) &&
			Date.now() - last.getTime() < 548 * 24 * 3600e3;
		budLabel = fresh
			? "Inwestycja w budowie"
			: `Inwestycja · ostatnia aktywność ${
					last && !Number.isNaN(last.getTime())
						? `${String(last.getMonth() + 1).padStart(2, "0")}.${last.getFullYear()}`
						: "?"
				}`;
	}

	// The investment description and the comments under it (scraped from
	// the topic's first page, features.posts).
	let threadHtml = "";
	if (isBudujesie) {
		const posts = features.budujesie?.posts ?? [];
		const opText = posts[0]?.text ?? "";
		if (opText) {
			const excerpt = opText.slice(0, 220);
			const comments = posts.slice(1, 4);
			threadHtml = `
	      <div class="border-t pt-1 text-xs">
	        <div class="font-medium text-amber-700">Inwestycja</div>
	        <div class="text-gray-600">${escapeHtml(excerpt)}${
						opText.length > 220 ? "…" : ""
					}</div>${
						comments.length > 0
							? `
	        <div class="mt-1 font-medium text-amber-700">Komentarze</div>${comments
						.map((comment) => {
							const text = comment.text ?? "";
							const date = dateLabel(comment.at);
							return `
	        <div class="mt-1 text-gray-600"><span class="font-medium text-gray-700">${escapeHtml(
						comment.author ?? "anonim",
					)}${
						date ? ` · ${escapeHtml(date)}` : ""
					}</span>: ${escapeHtml(text.slice(0, 160))}${
						text.length > 160 ? "…" : ""
					}</div>`;
						})
						.join("")}`
							: ""
					}
	      </div>`;
		}
	}

	// Investmap realizacja (planned completion quarter). Factual status
	// only: the planned quarter having passed is not proof of delivery.
	let realizationHtml = "";
	if (listing.constructionEndLabel) {
		realizationHtml = `<div class="text-amber-700">${escapeHtml(
			realizationCaption(
				listing.constructionEndLabel,
				listing.constructionEndDate,
			),
		)}</div>`;
	}

	// Short-term-rental context lines.
	const stayLines: string[] = [];
	if (listing.minimumStayNights != null && listing.minimumStayNights > 1)
		stayLines.push(
			`<div class="text-gray-500">Min. ${listing.minimumStayNights} nocy</div>`,
		);
	if (listing.availabilityCount != null && listing.availabilityCount > 0)
		stayLines.push(
			`<div class="text-gray-500">Wolne ~${listing.availabilityCount} nocy/rok</div>`,
		);

	// Amenity flags from the promoted columns plus the Airbnb amenity list.
	let amenitiesHtml = "";
	const amenityBadges = (
		[
			[attributes.hasBalcony, "Balkon"],
			[attributes.hasTerrace, "Taras"],
			[attributes.hasGarden, "Ogród"],
			[attributes.hasElevator, "Winda"],
			[attributes.hasParking, "Parking"],
			[attributes.hasGarage, "Garaż"],
			[attributes.hasBasement, "Piwnica"],
			[attributes.isFurnished, "Umeblowane"],
			[attributes.petsAllowed, "Zwierzęta OK"],
		] as Array<[boolean | null | undefined, string]>
	)
		.filter(([present]) => present)
		.map(([, label]) => label);
	const amenities = features.airbnb?.amenities ?? [];
	if (amenityBadges.length > 0 || amenities.length > 0) {
		const shown = amenities.slice(0, 6).map((amenity) => escapeHtml(amenity));
		const rest = amenities.length - shown.length;
		amenitiesHtml = `
	      <div class="border-t pt-1 text-xs">
	        <div class="font-medium text-emerald-700">Udogodnienia</div>
	        ${
						amenityBadges.length > 0
							? `<div class="mt-0.5 flex flex-wrap gap-1">${amenityBadges
									.map(
										(label) =>
											`<span class="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">${escapeHtml(label)}</span>`,
									)
									.join("")}</div>`
							: ""
					}
	        ${
						shown.length > 0
							? `<div class="mt-0.5 text-gray-600">${shown.join(", ")}${
									rest > 0
										? ` <span class="text-gray-400">+${rest} więcej</span>`
										: ""
								}</div>`
							: ""
					}
	      </div>`;
	}

	const updated = attributes.sourceUpdatedAt
		? new Date(attributes.sourceUpdatedAt)
		: null;
	const updatedLabel =
		updated && !Number.isNaN(updated.getTime())
			? updated.toLocaleDateString("pl-PL")
			: null;
	const updatedCaption =
		updatedLabel && updatedLabel !== addedLabel
			? ` · akt. ${updatedLabel}`
			: "";

	return `
    <div class="min-w-64 space-y-1 text-sm">
      <div class="flex items-start justify-between gap-2">
        <div class="font-semibold leading-tight">${escapeHtml(listing.title)}</div>
        ${
					statusBadge
						? `<span class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadge.className}">${escapeHtml(statusBadge.label)}</span>`
						: ""
				}
      </div>
      <div class="text-gray-500">${escapeHtml(location)}</div>
      <div class="flex justify-between gap-4 pt-1">
        <span class="font-medium${
					isBudujesie || isInvestmentRow ? " text-amber-700" : ""
				}">${
					isBudujesie
						? budLabel
						: isInvestmentRow
							? "Inwestycja"
							: `${priceText}${
									listing.pricePeriod === "night"
										? '<span class="text-xs font-normal text-gray-400"> /noc</span>'
										: ""
								}`
				}</span>
        <span>${
					isBudujesie
						? escapeHtml(threadStats)
						: listing.pricePerM2
							? `${Math.round(listing.pricePerM2).toLocaleString("pl-PL")} zł/m²`
							: ""
				}</span>
      </div>
      ${attributes.priceNegotiable ? '<div class="text-xs text-gray-500">Cena do negocjacji</div>' : ""}
      ${details ? `<div class="text-gray-500">${escapeHtml(details)}</div>` : ""}
      ${factsHtml}
      ${realizationHtml}
      ${
				listing.rating != null && listing.rating > 0
					? `<div><span class="font-medium">${listing.rating.toFixed(2)}</span> <span class="text-amber-500">★</span>${
							listing.reviewsCount
								? ` <span class="text-gray-400">(${listing.reviewsCount} opinii)</span>`
								: ""
						}</div>`
					: ""
			}
      ${utilities ? `<div class="text-gray-500">${escapeHtml(utilities)}</div>` : ""}
      ${costs ? `<div class="text-gray-500">${escapeHtml(costs)}</div>` : ""}
      ${auctionHtml}
      ${stayLines.join("\n      ")}
      <div class="text-gray-400">Dodano: ${addedLabel} · ${escapeHtml(sourceLabel(listing.source))}${updatedCaption}</div>
      ${threadHtml}
      ${amenitiesHtml}
      ${
				stats?.txCount
					? `<div class="border-t pt-1 text-xs">
          <div class="font-medium text-amber-700">RCN history: ${stats.txCount} transakcji</div>
          <div>Śr. ${formatPln(stats.txAvgPricePerM2)}/m²${range}</div>
        </div>`
					: ""
			}
      <a href="${listing.url}" target="_blank" rel="noreferrer" class="mt-1 block text-blue-600 underline">${
				isBudujesie ? "Otwórz wątek na BudujeSie.pl" : "Otwórz ogłoszenie"
			}</a>
    </div>`;
}

export interface PublicInvestmentPopupProps {
	name: string;
	categoryLabel: string;
	statusLabel: string;
	description: string | null;
	url: string | null;
	year: number | null;
	city: string | null;
}

/** Popup for the planned/completed public-investment layer. */
export function publicInvestmentPopupHtml(
	props: PublicInvestmentPopupProps,
): string {
	const meta = [props.categoryLabel, props.statusLabel, props.year]
		.filter((value) => value != null && value !== "")
		.join(" · ");
	return `
    <div class="min-w-56 space-y-1 text-sm">
      <div class="font-semibold leading-tight">${escapeHtml(props.name)}</div>
      <div class="text-gray-600">${escapeHtml(meta)}</div>
      ${props.city ? `<div class="text-gray-500">${escapeHtml(props.city)}</div>` : ""}
      ${
				props.description
					? `<p class="max-h-40 overflow-y-auto text-xs text-gray-600">${escapeHtml(
							props.description.slice(0, 600),
						)}</p>`
					: ""
			}
      ${
				props.url
					? `<a href="${props.url}" target="_blank" rel="noreferrer" class="mt-1 block text-blue-600 underline">Otwórz mapę źródłową</a>`
					: ""
			}
    </div>`;
}

/** "28 lat", "3 lata", "1 rok". */
export function ageLabel(year: number): string {
	const age = new Date().getFullYear() - year;
	const mod10 = age % 10;
	const mod100 = age % 100;
	const unit =
		age === 1
			? "rok"
			: mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)
				? "lata"
				: "lat";
	return `${age} ${unit}`;
}

export function buildingPopupHtml(data: BuildingLookup): string {
	if (!data?.building) {
		return `<div class="min-w-48 p-1 text-sm text-gray-600">
      <div class="font-medium">Budynek</div>
      <div>Brak danych o tym budynku.</div>
    </div>`;
	}
	const building = data.building;
	const stats = building.stats;
	const yearLine = building.buildYear
		? `<div class="flex justify-between gap-3"><span>Rok budowy</span><span class="font-medium">${building.buildYear} · ${ageLabel(building.buildYear)}</span></div>`
		: "";
	if (!stats) {
		// Building found but no RCN history (address fallback).
		return `<div class="min-w-56 space-y-1 text-sm">
      <div class="font-semibold">${escapeHtml(building.address ?? "Budynek (bez adresu)")}</div>
      <div class="border-t pt-1">${yearLine || '<div class="text-xs text-gray-500">Brak danych o wieku budynku.</div>'}</div>
      <div class="text-xs text-gray-500">Brak transakcji RCN dla tego budynku.</div>
    </div>`;
	}
	const range =
		stats.minDate && stats.maxDate
			? ` (${stats.minDate.slice(0, 4)}-${stats.maxDate.slice(0, 4)})`
			: "";
	const byYear =
		stats.byYear.length > 0
			? `<div class="mt-1 border-t pt-1">
          ${stats.byYear
						.map(
							(row) =>
								`<div class="flex justify-between gap-3">
                  <span>${row.year}: ${row.count} ${row.count === 1 ? "transakcja" : row.count < 5 ? "transakcje" : "transakcji"}</span>
                  <span class="font-medium">${stats.avgPricePerM2 ? `${Math.round(row.avgPricePerM2 ?? 0).toLocaleString("pl-PL")} zł/m²` : ""}</span>
                </div>`,
						)
						.join("")}
        </div>`
			: "";
	const recent =
		stats.recent.length > 0
			? `<div class="mt-1 border-t pt-1 text-xs">
          ${stats.recent
						.map((transaction) => {
							const address = transaction.street
								? `${escapeHtml(transaction.street)}${transaction.streetNumber ? ` ${escapeHtml(transaction.streetNumber)}` : ""}`
								: null;
							return `<div class="flex justify-between gap-3">
                  <span>${transaction.date.slice(0, 7)}${address ? ` · ${address}` : ""}</span>
                  <span>${transaction.price.toLocaleString("pl-PL")} zł${transaction.areaM2 ? ` · ${Math.round(transaction.areaM2)} m²` : ""}${transaction.pricePerM2 ? ` · ${Math.round(transaction.pricePerM2).toLocaleString("pl-PL")} zł/m²` : ""}</span>
                </div>`;
						})
						.join("")}
        </div>`
			: "";
	return `<div class="min-w-60 space-y-1 text-sm">
    <div class="font-semibold">${escapeHtml(building.address ?? "Budynek (bez adresu)")}</div>
    <div class="text-xs text-gray-500">Historia transakcji RCN</div>
    ${yearLine ? `<div class="border-t pt-1">${yearLine}</div>` : ""}
    ${
			stats.txCount > 0
				? `<div class="border-t pt-1">
          <div class="flex justify-between gap-3"><span>Liczba transakcji</span><span class="font-medium">${stats.txCount}${range}</span></div>
          <div class="flex justify-between gap-3"><span>Średnia cena</span><span class="font-medium">${stats.avgPricePerM2 ? `${Math.round(stats.avgPricePerM2).toLocaleString("pl-PL")} zł/m²` : "n/d"}</span></div>
          <div class="flex justify-between gap-3"><span>Zakres</span><span>${stats.minPricePerM2 ? `${Math.round(stats.minPricePerM2).toLocaleString("pl-PL")} – ${Math.round(stats.maxPricePerM2 ?? 0).toLocaleString("pl-PL")} zł/m²` : "n/d"}</span></div>
        </div>${byYear}${recent}`
				: `<div class="text-xs text-gray-500">Brak transakcji w tym budynku.</div>`
		}
  </div>`;
}

export function renderValuationHtml(valuation: OfferValuation): string {
	const pl = (value: number) => Math.round(value).toLocaleString("pl-PL");
	const comp = (label: string, value: { avgM2: number; n: number } | null) =>
		value
			? `<div class="flex justify-between"><span class="text-gray-500">${label}</span><span>${pl(value.avgM2)} zł/m² <span class="text-gray-400">(${value.n})</span></span></div>`
			: "";
	const roi = (
		label: string,
		value: { n: number; netMonthly: number; netYieldPct: number | null },
		color: string,
	) =>
		value.netYieldPct != null
			? `<div class="mt-1 border-t pt-1">
					<div class="font-medium ${color}">${label} (netto)</div>
					<div class="text-gray-600">${pl(value.netMonthly)} zł/mies. netto → ROI <b>${value.netYieldPct.toFixed(1)}%</b>/rok</div>
					<div class="text-gray-400 text-xs">${value.n} porównań w okolicy</div>
				</div>`
			: "";
	return `<div class="mt-2 border-t pt-1 text-xs">
		<div class="font-medium">Wycena vs rynek</div>
		${valuation.comps.fairM2 != null ? `<div>godziwa: <b>${pl(valuation.comps.fairM2)} zł/m²</b>${valuation.overUnderPct != null ? ` · <span class="${valuation.rating?.tone ?? ""} font-medium">${valuation.rating?.label} ${valuation.overUnderPct > 0 ? "+" : ""}${valuation.overUnderPct}%</span>` : ""}</div>` : ""}
		${comp("ten budynek", valuation.comps.building)}
		${comp("okolica", valuation.comps.area)}
		${comp("RCN 1 km / 24 mies.", valuation.comps.rcn)}
		${valuation.lt ? roi("Najem długoterminowy", valuation.lt, "text-emerald-700") : ""}
		${valuation.str ? roi("Najem krótkoterminowy (szac.)", valuation.str, "text-rose-700") : ""}
	</div>`;
}
