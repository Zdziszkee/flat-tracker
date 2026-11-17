import mapboxgl from "mapbox-gl";

import { POPUP_CLASS } from "./chrome";
import { publicInvestmentColorExpr } from "./icons";
import { publicInvestmentPopupHtml } from "./popups";
import { apiUrl } from "./url";

const PUBLIC_INVESTMENT_LAYER_ID = "public-investments";

/**
 * Planned/completed public investments (city roads, schools, parks, sport,
 * culture). Their own point layer, under the listings so offers stay
 * clickable; the toggle controls visibility.
 */
export function addPublicInvestmentLayer(
	map: mapboxgl.Map,
	visible: boolean,
): void {
	if (map.getSource(PUBLIC_INVESTMENT_LAYER_ID)) return;
	map.addSource(PUBLIC_INVESTMENT_LAYER_ID, {
		type: "geojson",
		data: apiUrl("/api/public-investments"),
	});
	map.addLayer({
		id: PUBLIC_INVESTMENT_LAYER_ID,
		type: "circle",
		source: PUBLIC_INVESTMENT_LAYER_ID,
		layout: {
			visibility: visible ? "visible" : "none",
		},
		paint: {
			"circle-color": publicInvestmentColorExpr(),
			"circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 16, 9],
			"circle-opacity": 0.9,
			"circle-stroke-color": "#ffffff",
			"circle-stroke-width": 1.5,
		},
	});
	map.on("click", PUBLIC_INVESTMENT_LAYER_ID, (event) => {
		const feature = event.features?.[0];
		if (!feature) return;
		const props =
			(
				feature as unknown as {
					properties?: Record<string, unknown>;
				}
			).properties ?? {};
		const rawYear = props.year;
		const year = rawYear == null || rawYear === "" ? null : Number(rawYear);
		const html = publicInvestmentPopupHtml({
			name: String(props.name ?? "Inwestycja"),
			categoryLabel: String(props.categoryLabel ?? ""),
			statusLabel: String(props.statusLabel ?? ""),
			description:
				typeof props.description === "string" ? props.description : null,
			url: typeof props.url === "string" ? props.url : null,
			year: year !== null && Number.isFinite(year) ? year : null,
			city: typeof props.city === "string" ? props.city : null,
		});
		new mapboxgl.Popup({ className: POPUP_CLASS, maxWidth: "340px" })
			.setLngLat(event.lngLat)
			.setHTML(html)
			.addTo(map);
	});
	map.on("mouseenter", PUBLIC_INVESTMENT_LAYER_ID, () => {
		map.getCanvas().style.cursor = "pointer";
	});
	map.on("mouseleave", PUBLIC_INVESTMENT_LAYER_ID, () => {
		map.getCanvas().style.cursor = "";
	});
}

/** Public-investment layer visibility (data is static for the session). */
export function setPublicInvestmentsVisible(
	map: mapboxgl.Map,
	visible: boolean,
): void {
	if (!map.getLayer(PUBLIC_INVESTMENT_LAYER_ID)) return;
	map.setLayoutProperty(
		PUBLIC_INVESTMENT_LAYER_ID,
		"visibility",
		visible ? "visible" : "none",
	);
}
