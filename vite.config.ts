import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const refreshTask = fileURLToPath(
	new URL("./server/tasks/refresh.ts", import.meta.url),
);
const airbnbCalendarTask = fileURLToPath(
	new URL("./server/tasks/airbnb-calendar.ts", import.meta.url),
);
const bookingCalendarTask = fileURLToPath(
	new URL("./server/tasks/booking-calendar.ts", import.meta.url),
);
const refreshPlugin = fileURLToPath(
	new URL("./server/plugins/refresh-on-start.ts", import.meta.url),
);

const config = defineConfig({
	resolve: { tsconfigPaths: true },
	// Vite's dependency scanner walks the *raw* module graph, before TanStack
	// Start strips server handlers from route modules. From `src/routes/` it
	// therefore reaches every API route, `#/db` (better-sqlite3, drizzle) and,
	// through the refresh route's lazy import, the whole crawler graph
	// (Crawlee, Playwright, camoufox, Effect). Prebundling that server-only
	// graph took minutes on a cold dep cache and blocked the first page load;
	// none of it is ever requested by the browser. With discovery off, only
	// the packages below are prebundled, which is all the client imports.
	optimizeDeps: {
		noDiscovery: true,
		include: [
			"@t3-oss/env-core",
			"@tanstack/charts",
			"@tanstack/charts/react",
			"@tanstack/charts/scales/band",
			"@tanstack/charts/scales/linear",
			"@tanstack/react-devtools",
			"@tanstack/react-query",
			"@tanstack/react-query-devtools",
			"@tanstack/react-router",
			"@tanstack/react-router-devtools",
			"@tanstack/react-router-ssr-query",
			"mapbox-gl",
			"react",
			"react-dom",
			"react-dom/client",
			"react/compiler-runtime",
			"react/jsx-dev-runtime",
			"react/jsx-runtime",
			"zod",
		],
	},
	plugins: [
		devtools(),
		nitro({
			// @aws-sdk/* is an optional dep of `unzipper` (S3 zip sources);
			// we only extract local files, so never bundle it.
			rollupConfig: {
				external: [
					/^@sentry\//,
					/^@aws-sdk\//,
					// Crawlee & browser drivers reference `__dirname` and CJS
					// shims that break when inlined into a single ESM server
					// bundle. Keep them external so they load from node_modules
					// at runtime (the prod refresh task hits this too).
					/^@crawlee\//,
					/^playwright/,
					/^puppeteer/,
					/^linkedom$/,
					/^jsdom$/,
					/^got-scraping/,
					// camoufox-js (Booking anti-detect) pulls `impit`, whose
					// native .node binary must load from node_modules, not be
					// inlined/read as text by the bundler.
					/^camoufox/,
					/^impit($|\/)/,
					/^fingerprint-generator$/,
				],
			},
			experimental: { tasks: true },
			// Register the refresh task and startup plugin explicitly (no
			// directory scanning; TanStack Start manages its own routes).
			plugins: [refreshPlugin],
			tasks: {
				refresh: {
					handler: refreshTask,
					description: "Crawl all sources, prune stale offers, import RCN diff",
				},
				"airbnb-calendar": {
					handler: airbnbCalendarTask,
					description:
						"Import Airbnb availability calendars and fold monthly prices",
				},
				"booking-calendar": {
					handler: bookingCalendarTask,
					description:
						"Import Booking.com availability calendars and fold occupancy stats",
				},
			},
			// Hourly data refresh: the same refreshAll() the /sources page and
			// the dev boot use, including the incremental RCN diff check that
			// skips the 2 GB download when the registry is unchanged.
			scheduledTasks: {
				"0 * * * *": "refresh",
				"0 3 * * *": "airbnb-calendar",
				"30 3 * * *": "booking-calendar",
			},
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		babel({ presets: [reactCompilerPreset()] }),
	],
});

export default config;
