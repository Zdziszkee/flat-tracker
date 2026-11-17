import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";

/** Chart palette for the dark dashboard. */
export const CHART_THEME = {
	foreground: "#d4d4d8",
	muted: "#a1a1aa",
	grid: "rgba(255,255,255,0.12)",
	background: "transparent",
} as const;

export const SERIES = {
	blue: "#60a5fa",
	amber: "#fbbf24",
	green: "#4ade80",
	violet: "#a78bfa",
	emerald: "#34d399",
	rose: "#fb7185",
	orange: "#fb923c",
	cyan: "#22d3ee",
	teal: "#2dd4bf",
	tealDeep: "#14b8a6",
	red: "#f87171",
	slate: "#94a3b8",
	booking: "#3b82f6",
	dotViolet: "#c084fc",
} as const;

/** Categorical x axis with a little breathing room between bars. */
export function bandX(label: string) {
	return {
		scale: () => scaleBand<string>().padding(0.25),
		axis: { label },
	};
}

/** Nice numeric axis with a grid (direction-independent). */
export function linX(label: string) {
	return {
		scale: scaleLinear,
		nice: true,
		grid: true,
		axis: { label },
	};
}

/** Numeric y axis; same shape as `linX`. */
export function linY(label: string) {
	return linX(label);
}
