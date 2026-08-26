import { launchOptions } from "camoufox-js";
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

let camoufoxAvailable: boolean | null = null;

async function detectCamoufox(): Promise<boolean> {
	if (camoufoxAvailable !== null) return camoufoxAvailable;
	try {
		// Resolving the module is enough to know whether it was installed.
		await import("camoufox-js");
		camoufoxAvailable = true;
	} catch {
		camoufoxAvailable = false;
	}
	return camoufoxAvailable;
}

/**
 * Returns a Playwright-compatible `Browser` for a Booking-style crawl.
 * Tries camoufox first, falls back to plain Playwright Firefox.
 */
export async function bookingLauncherFactory(
	headless = true,
): Promise<AppBrowser> {
	const useCamoufox = await detectCamoufox();
	if (useCamoufox) {
		try {
			// `launchOptions` produces a Playwright Firefox launch config that
			// points at the downloaded camoufox binary. It injects a `viewport`
			// object Playwright's launcher schema rejects, so strip it.
			const opts = await launchOptions({ os: ["linux"] });
			const { viewport: _omit, ...rest } = opts as Record<string, unknown>;
			return (await firefox.launch({
				...rest,
				headless,
			})) as unknown as AppBrowser;
		} catch (err) {
			console.warn(
				"[camoufox] launch failed, falling back to plain Playwright:",
				err,
			);
		}
	}
	return chromium.launch({ headless });
}
