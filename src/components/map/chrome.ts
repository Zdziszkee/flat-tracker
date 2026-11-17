/**
 * Scoped dark chrome for Mapbox's own DOM (popup shell, nav controls,
 * attribution). mapbox-gl.css hardcodes white surfaces; styles.css is owned
 * elsewhere, so MapView renders this once alongside the canvas. The popup
 * overrides only apply to popups created with POPUP_CLASS.
 */
export const MAP_DARK_CSS = `
.ft-map-popup .mapboxgl-popup-content {
	background-color: var(--popover);
	color: var(--popover-foreground);
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	box-shadow: 0 12px 32px rgb(0 0 0 / 0.5);
}
.ft-map-popup .mapboxgl-popup-tip {
	border-top-color: var(--popover);
	border-bottom-color: var(--popover);
	border-left-color: var(--popover);
	border-right-color: var(--popover);
}
.mapboxgl-ctrl-group {
	background-color: var(--popover);
	border: 1px solid var(--border);
}
.mapboxgl-ctrl-group button + button {
	border-top-color: var(--border);
}
.mapboxgl-ctrl-group button:not(:disabled):hover {
	background-color: var(--accent);
}
.mapboxgl-ctrl-group .mapboxgl-ctrl-icon {
	filter: invert(0.92);
}
.mapboxgl-ctrl-attrib {
	background-color: color-mix(in oklab, var(--popover) 82%, transparent);
	color: var(--muted-foreground);
}
.mapboxgl-ctrl-attrib a {
	color: var(--muted-foreground);
}
.mapboxgl-ctrl-attrib-button {
	filter: invert(0.92);
}
`;

/** Every popup we create carries this class so MAP_DARK_CSS can theme it. */
export const POPUP_CLASS = "ft-map-popup";
