/**
 * Validate the pure finwire parsing/chaining: ng-state extraction and the
 * base-100 chain. Run with `bun run validate:finwire`.
 */
import {
	chainCityTrend,
	parseFinwireCityPage,
} from "../src/lib/valuation/finwire-trend.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

const state = JSON.stringify({
	"cm-rcn-city:krakow": {
		slug: "krakow",
		name: "Kraków",
		latestQuarter: "2026-Q2",
		firstQuarter: "2010-Q1",
		trend: [
			{ quarter: "2025-Q1", medianM2: 14000, n: 3151 },
			{ quarter: "2025-Q2", medianM2: 14700, n: 2563 },
		],
	},
	"cm-rcn-city:katowice": {
		slug: "katowice",
		name: "Katowice",
		latestQuarter: "2026-Q2",
		trend: [{ quarter: "2025-Q1", medianM2: 9000, n: 900 }],
	},
});
const html = `<html><head><script id="ng-state" type="application/json">${state}</script></head></html>`;

const krakow = parseFinwireCityPage(html, "krakow");
check(krakow != null, "parses the krakow payload");
check(krakow?.trend.length === 2, "keeps both quarters");
check(krakow?.latestQuarter === "2026-Q2", "reads latestQuarter");

check(parseFinwireCityPage(html, "nowhere") == null, "unknown slug returns null");
check(parseFinwireCityPage("<html></html>", "krakow") == null, "no ng-state returns null");
// A single quarter is not a trend.
check(
	parseFinwireCityPage(html, "katowice") == null,
	"single-quarter city is rejected",
);

const chained = chainCityTrend([
	{ quarter: "2025-Q2", medianM2: 12000, n: 20 },
	{ quarter: "2025-Q1", medianM2: 10000, n: 18 },
	{ quarter: "2025-Q3", medianM2: 13200, n: 22 },
]);
check(chained.length === 3, "chain keeps all quarters");
check(chained[0]?.quarter === "2025-Q1", "chain sorts by quarter");
check(chained[0]?.indexValue === 100, "first quarter is 100");
check(
	Math.abs((chained[1]?.indexValue ?? 0) - 120) < 1e-9,
	"second quarter links 100 -> 120",
);
check(
	Math.abs((chained[2]?.indexValue ?? 0) - 132) < 1e-9,
	"third quarter compounds 120 -> 132",
);
check(chained[2]?.medianM2 === 13200, "median is carried through");

const outlier = chainCityTrend([
	{ quarter: "2025-Q1", medianM2: 10000, n: 20 },
	{ quarter: "2025-Q2", medianM2: 48000, n: 22 },
	{ quarter: "2025-Q3", medianM2: 10500, n: 24 },
]);
check(outlier.length === 2, "outlier quarter is skipped");
check(
	Math.abs((outlier[1]?.indexValue ?? 0) - 105) < 1e-9,
	"chain resumes from the last accepted point",
);

const zero = chainCityTrend([
	{ quarter: "2025-Q1", medianM2: 0, n: 10 },
	{ quarter: "2025-Q2", medianM2: 10000, n: 12 },
	{ quarter: "2025-Q3", medianM2: 10100, n: 12 },
]);
check(zero.length === 2, "zero median is dropped");
check(zero[0]?.indexValue === 100, "chain starts at the first positive median");

if (failures > 0) {
	console.error(`\n${failures} finwire check(s) failed.`);
	process.exit(1);
}
console.log("\nAll finwire checks passed.");
