import { existsSync } from "node:fs";

/**
 * Playwright's browser binaries are a separate download (`npx playwright
 * install chromium`); a fresh clone has the npm package but no browser, so
 * every browser-driven source fails with a wall of stack traces. Check
 * once per process and say what to run instead.
 */

let playwrightReady: boolean | null = null;

/** True when Playwright's chromium download is present. */
export async function playwrightBrowsersInstalled(): Promise<boolean> {
	if (playwrightReady !== null) return playwrightReady;
	try {
		const { chromium } = await import("playwright");
		playwrightReady = existsSync(chromium.executablePath());
	} catch {
		playwrightReady = false;
	}
	return playwrightReady;
}

/**
 * One-line hint when browser-rendered sources cannot run. `sites` are the
 * adapter ids that need a browser (booking, licytacje-komornik, ...).
 */
export async function warnIfBrowserSourcesUnavailable(
	sites: string[],
): Promise<void> {
	if (sites.length === 0) return;
	if (await playwrightBrowsersInstalled()) return;
	console.warn(
		`[crawler] Playwright browsers are not installed: ${sites.join(", ")} ` +
			"will fail this run. Enable them with `npx playwright install chromium` " +
			"(plus `npx camoufox fetch` for the Booking anti-detect browser).",
	);
}
