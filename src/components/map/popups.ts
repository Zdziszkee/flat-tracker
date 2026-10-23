import {
	dateLabel,
	formatPln,
	formatUtilities,
	realizationCaption,
	yearOf,
} from "#/lib/format";
import { escapeHtml } from "#/lib/html";
import { parseListingFeatures } from "#/lib/listing-features";
import type { OfferValuation } from "#/types/listing";
import type { ApiListing, BuildingLookup } from "./types";

export function popupHtml(listing: ApiListing): string {
	const stats = listing.transactionStats;
	const features = parseListingFeatures(listing.features);
	const minYear = yearOf(stats?.txMinDate);
	const maxYear = yearOf(stats?.txMaxDate);
	const range = minYear && maxYear ? ` (${minYear}-${maxYear})` : "";
	const added = listing.listedAt ?? listing.firstSeenAt;
	const addedLabel = added
		? new Date(added).toLocaleDateString("pl-PL")
		: "n/d";
	const location =
		listing.address ?? listing.district ?? listing.buildingAddress ?? "";

	// Physical layout: portal columns first, then Airbnb PDP extraction.
	// bedrooms wins over rooms so short-term rentals show sypialnie.
	const layoutParts: string[] = [];
	if (listing.areaM2) layoutParts.push(`${listing.areaM2} m²`);
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
	if (listing.floor) layoutParts.push(`piętro ${listing.floor}`);
	if (listing.propertyType) layoutParts.push(listing.propertyType);
	const details = layoutParts.join(" · ");

	const heating = listing.heatingType
		? `Ogrzewanie: ${listing.heatingType}`
		: "";
	const utilities = formatUtilities(listing.utilities);

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

	// Amenities preview from the enriched features JSON.
	let amenitiesHtml = "";
	const amenities = features.airbnb?.amenities ?? [];
	if (amenities.length > 0) {
		const shown = amenities.slice(0, 6).map((amenity) => escapeHtml(amenity));
		const rest = amenities.length - shown.length;
		amenitiesHtml = `
	      <div class="border-t pt-1 text-xs">
	        <div class="font-medium text-emerald-700">Udogodnienia</div>
	        <div class="text-gray-600">${shown.join(", ")}${
						rest > 0
							? ` <span class="text-gray-400">+${rest} więcej</span>`
							: ""
					}</div>
	      </div>`;
	}

	return `
    <div class="min-w-56 space-y-1 text-sm">
      <div class="font-semibold leading-tight">${escapeHtml(listing.title)}</div>
      <div class="text-gray-500">${escapeHtml(location)}</div>
      <div class="flex justify-between gap-4 pt-1">
        <span class="font-medium${
					isBudujesie || isInvestmentRow ? " text-amber-700" : ""
				}">${
					isBudujesie
						? budLabel
						: isInvestmentRow
							? "Inwestycja"
							: `${formatPln(listing.price)}${
									listing.pricePeriod === "night"
										? '<span class="text-xs font-normal text-gray-400"> /noc</span>'
										: ""
								}`
				}</span>
        <span>${
					isBudujesie
						? escapeHtml(threadStats)
						: listing.pricePerM2
							? `${listing.pricePerM2.toFixed(0)} zł/m²`
							: ""
				}</span>
      </div>
      <div class="text-gray-500">${escapeHtml(details)}</div>
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
      ${heating ? `<div class="text-gray-500">${escapeHtml(heating)}</div>` : ""}
      ${utilities ? `<div class="text-gray-500">${escapeHtml(utilities)}</div>` : ""}
      ${stayLines.join("\n      ")}
      <div class="text-gray-400">Dodano: ${addedLabel}</div>
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
