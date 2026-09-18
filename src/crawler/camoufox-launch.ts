import { chromium } from "playwright";
// camoufox-js peers on playwright-core <1.61.0; using its `firefox` (1.60.0)
// for the camoufox launch avoids the viewport schema mismatch that the newer
// `playwright` (1.62) firefox throws on camoufox's injected context options.
import { firefox } from "playwright-core";

// The launcher mixes playwright-core (camoufox peer, 1.60) with the app's
// `playwright` (1.62); their `Browser` types differ structurally, so every
// return crosses the boundary through an explicit cast.
type AppBrowser = import("playwright").Browser;

/**
 * Booking.com (and some other DataDome-protected portals) serve a degraded,
 * static search page — no "load more" button, ~25 cards — to ordinary
 * automated browsers. Camoufox is a Firefox anti-detect build whose injected
 * fingerprint makes Booking return the real interactive view (full property
 * count + the load-more button). We therefore *prefer* camoufox when it is
 * installed, and silently fall back to the normal Playwright Firefox launcher
 * (which still yields the first ~25 cards) when camoufox is unavailable.
 */

/** Resolved once per process: null = not probed yet, false = unusable. */
let camoufoxOpts: Record<string, unknown> | null | false = null;

/** First line of an error, for one-line logs. */
function brief(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.split("\n")[0];
}

/**
 * Cached camoufox launch options, or null when camoufox is not usable
 * (package or browser binary missing). Probing is cached: without it, a
 * fresh clone logs a full stack trace for every Booking page.
 */
async function getCamoufoxOptions(): Promise<Record<string, unknown> | null> {
	if (camoufoxOpts === false) return null;
	if (camoufoxOpts !== null) return camoufoxOpts;
	try {
		// Lazy + @vite-ignore: never let the bundler touch camoufox-js (its
		// impit native binary cannot be prebundled). `launchOptions` also
		// resolves the downloaded camoufox build, so a missing browser is
		// detected here rather than at launch time.
		const { launchOptions } = await import(/* @vite-ignore */ "camoufox-js");
		const opts = (await launchOptions({ os: ["linux"] })) as Record<
			string,
			unknown
		>;
		camoufoxOpts = opts;
		return opts;
	} catch (err) {
		camoufoxOpts = false;
		console.warn(
			`[camoufox] unavailable, using plain Playwright chromium: ${brief(err)} ` +
				"(enable with `npx camoufox fetch`)",
		);
		return null;
	}
}

/**
 * Returns a Playwright-compatible `Browser` for a Booking-style crawl.
 * Tries camoufox first, falls back to plain Playwright Firefox.
 */
export async function bookingLauncherFactory(
	headless = true,
): Promise<AppBrowser> {
	const opts = await getCamoufoxOptions();
	if (opts) {
		try {
			// `launchOptions` produces a Playwright Firefox launch config that
			// points at the downloaded camoufox binary. It injects a `viewport`
			// object Playwright's launcher schema rejects, so strip it.
			const { viewport: _omit, ...rest } = opts;
			return (await firefox.launch({
				...rest,
				headless,
			})) as unknown as AppBrowser;
		} catch (err) {
			console.warn(
				`[camoufox] launch failed, falling back to plain Playwright chromium: ${brief(err)}`,
			);
		}
	}
	return chromium.launch({ headless });
}
