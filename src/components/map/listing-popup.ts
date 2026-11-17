import mapboxgl from "mapbox-gl";

import type {
	ListingDto,
	MapFeedPoint,
	MapListingDto,
	OfferValuation,
} from "#/types/listing";
import { POPUP_CLASS } from "./chrome";
import { mapListingPopupHtml, popupHtml, renderValuationHtml } from "./popups";
import type { PopupRef } from "./types";

/**
 * Click handler for the listing layers. Overview cells zoom in; exact points
 * paint the compact popup shell first, then hydrate it with the single-row
 * detail response (which carries attributes/journal/transaction stats).
 *
 * Click features are backed by `queryRenderedFeatures`, which drops nested
 * objects, so the compact row is read from the source data instead.
 */
export function showListingPopup(
	map: mapboxgl.Map,
	event: mapboxgl.MapLayerMouseEvent,
	popupRef: PopupRef,
): void {
	const feature = event.features?.[0] as { properties?: unknown } | undefined;
	const props = feature?.properties;
	if (!props) return;
	const point = props as MapFeedPoint;
	// Overview cells zoom instead of opening a popup; the count is
	// already printed on the circle.
	if (point.kind === "cluster") {
		map.easeTo({
			center: [point.lng, point.lat],
			zoom: Math.min(map.getZoom() + 2, 17),
			duration: 450,
		});
		return;
	}
	const listing = point as MapListingDto;
	popupRef.current?.remove();
	const popup = new mapboxgl.Popup({
		className: POPUP_CLASS,
		offset: 16,
		closeButton: false,
		maxWidth: "360px",
	})
		.setLngLat(event.lngLat)
		.setHTML(mapListingPopupHtml(listing))
		.addTo(map);
	popupRef.current = popup;
	const fitPopup = () => {
		// The popup now carries a parameter grid, costs, amenities and
		// the valuation slot; let tall popups scroll instead of
		// running off the viewport.
		const content = popup
			.getElement()
			?.querySelector<HTMLElement>(".mapboxgl-popup-content");
		if (content) {
			content.style.maxHeight = "70vh";
			content.style.overflowY = "auto";
		}
	};
	fitPopup();
	// The compact map row is enough to paint the popup shell; the
	// full attributes/journal/transaction payload arrives in one
	// small request for just this offer.
	void fetch(`/api/listings?view=detail&id=${listing.id}`)
		.then((response) => {
			if (!response.ok) throw new Error(`detail ${response.status}`);
			return response.json() as Promise<{ listing: ListingDto }>;
		})
		.then(({ listing: detail }) => {
			if (popupRef.current !== popup) return;
			const wantValuation =
				detail.price != null &&
				(detail.offerType === "sale" ||
					detail.offerType === "long_term_rental");
			popup.setHTML(
				wantValuation
					? `${popupHtml(detail)}<div id="popup-valuation" class="text-muted-foreground text-xs">Liczenie wyceny…</div>`
					: popupHtml(detail),
			);
			fitPopup();
			if (!wantValuation) return;
			void fetch(`/api/valuation/offer?id=${detail.id}`)
				.then((r) => r.json())
				.then((v: OfferValuation) => {
					if (popupRef.current !== popup) return; // stale popup
					const slot = document.getElementById("popup-valuation");
					if (slot) slot.outerHTML = renderValuationHtml(v);
				})
				.catch(() => {
					const slot = document.getElementById("popup-valuation");
					if (slot && popupRef.current === popup) {
						slot.textContent = "Wycena niedostępna.";
					}
				});
		})
		.catch(() => {
			if (popupRef.current === popup) {
				popup.setHTML(
					`${mapListingPopupHtml(listing)}<div class="text-xs text-destructive-foreground">Nie udało się pobrać szczegółów.</div>`,
				);
				fitPopup();
			}
		});
}
