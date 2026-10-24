import { existsSync } from "node:fs";

import { chromium } from "playwright";
import { firefox } from "playwright-core";

/**
 * One browser stack for every JS-rendered source (booking,
 * licytacje-komornik, eLicytacje KAS).
 *
 * camoufox — a patched Firefox with an anti-detect fingerprint, installed
 * once with `bunx camoufox-js fetch` (~660 MB) — is preferred, so no
 * Playwright browser download is needed at all. Chromium stays as the
 * fallback for machines that already ran `bunx playwright install chromium`.
 *
 * Note that camoufox is driven *through* Playwright (`playwright-core`
 * launches its Firefox build), so Playwright the library stays; what becomes
 * unnecessary is Playwright's own browser download.
 *
 * Callers create their context with `viewport: null` so camoufox's spoofed
 * window size survives (Playwright's default viewport fights the injected
 * fingerprint and can hang a second page on some builds).
 */

type AppBrowser = import("playwright").Browser;
type AppContext = import("playwright").BrowserContext;

/** First line of the deepest cause, for one-line logs. */
function brief(err: unknown): string {
	let cur: unknown = err;
	for (let i = 0; i < 5 && cur instanceof Error && cur.cause; i++)
		cur = cur.cause;
	const message = cur instanceof Error ? cur.message : String(cur);
	return message.split("\n").find((line) => line.trim()) ?? message;
}

let camoufox: Promise<Record<string, unknown> | null> | null = null;

/**
 * camoufox launch options, or null when camoufox is not usable. Probed
 * once: `launchOptions` resolves the downloaded browser, so a missing one
 * is detected here rather than on every launch.
 */
function camoufoxOptions(): Promise<Record<string, unknown> | null> {
	camoufox ??= (async () => {
		try {
			// Lazy + @vite-ignore: camoufox-js pulls a native `impit` binary
			// the bundler must not inline.
			const { launchOptions } = await import(/* @vite-ignore */ "camoufox-js");
			return await launchOptions({ os: ["linux"] });
		} catch {
			return null;
		}
	})();
	return camoufox;
}

/** Launch the best available browser. The caller closes it. */
export async function launchBrowser(headless = true): Promise<AppBrowser> {
	const options = await camoufoxOptions();
	if (options) {
		try {
			// camoufox injects a `viewport` object that Playwright's launcher
			// schema rejects, so strip it (the injected window size is kept).
			const { viewport: _viewport, ...rest } = options;
			return (await firefox.launch({
				...rest,
				headless,
			})) as unknown as AppBrowser;
		} catch (err) {
			console.warn(
				`[browser] camoufox launch failed, falling back to chromium: ${brief(err)}`,
			);
		}
	}
	return chromium.launch({ headless });
}

/**
 * Launch a browser with a persistent profile directory.
 *
 * Some WAF-protected sources (eLicytacje KAS behind Incapsula) solve their
 * challenge with cookies and a browser fingerprint that the next run must
 * reuse. A fresh context each time re-triggers the challenge and can end in
 * a hard block, so the caller passes a profile directory under `data/`.
 * The browser context is returned directly (there is no separate Browser
 * handle for persistent contexts); the caller closes it.
 */
export async function launchPersistentBrowserContext(
	userDataDir: string,
	headless = true,
): Promise<AppContext> {
	const options = await camoufoxOptions();
	if (options) {
		try {
			const { viewport: _viewport, ...rest } = options;
			return await firefox.launchPersistentContext(userDataDir, {
				...rest,
				headless,
			});
		} catch (err) {
			console.warn(
				`[browser] camoufox persistent launch failed, falling back to chromium: ${brief(err)}`,
			);
		}
	}
	return chromium.launchPersistentContext(userDataDir, {
		headless,
		locale: "pl-PL",
	});
}

/**
 * Warn once per refresh when neither browser is installed, so the failure
 * of the rendered sources is explained instead of buried in stack traces.
 */
export async function warnIfNoBrowser(sites: string[]): Promise<void> {
	if (sites.length === 0) return;
	if ((await camoufoxOptions()) || existsSync(chromium.executablePath()))
		return;
	console.warn(
		`[crawler] no browser for ${sites.join(", ")}: run \`bunx camoufox-js fetch\` ` +
			"(or `bunx playwright install chromium` as a fallback)",
	);
}
