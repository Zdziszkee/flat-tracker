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
const refreshPlugin = fileURLToPath(
	new URL("./server/plugins/refresh-on-start.ts", import.meta.url),
);

const config = defineConfig({
	resolve: { tsconfigPaths: true },
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
			},
			// Hourly data refresh (same program as `npm run crawl:all`, which
			// does an incremental RCN diff check before any 2 GB download).
			scheduledTasks: {
				"0 * * * *": "refresh",
				"0 3 * * *": "airbnb-calendar",
			},
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		babel({ presets: [reactCompilerPreset()] }),
	],
});

export default config;
