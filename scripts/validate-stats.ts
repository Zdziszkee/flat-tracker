/**
 * Validate the shared numeric core in src/lib/stats.ts.
 *
 * Pure: no DB, no network, no clock. Pins the empty-sample semantics, the
 * quantile interpolation, the upperMedian distinction the market charts
 * depend on, and the weighted-quantile weight handling.
 * Run with `bunx tsx scripts/validate-stats.ts`.
 */

import {
	clamp,
	median,
	quantile,
	upperMedian,
	weightedQuantile,
} from "../src/lib/stats.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

function near(actual: number | null, expected: number, tolerance = 1e-9): boolean {
	return actual != null && Math.abs(actual - expected) <= tolerance;
}

// --- clamp ---------------------------------------------------------------
check(clamp(5, 0, 10) === 5, "clamp keeps an in-range value");
check(clamp(-5, 0, 10) === 0, "clamp raises to the lower bound");
check(clamp(15, 0, 10) === 10, "clamp lowers to the upper bound");
check(clamp(5, 10, 0) === 0, "inverted bounds resolve to the numeric lower bound");
check(
	clamp(0.5, 0.2, 1) === 0.5 && clamp(-0.1, 0.2, 1) === 0.2,
	"clamp works on fractional bounds",
);

// --- quantile ------------------------------------------------------------
check(quantile([], 0.5) === null, "quantile is null on an empty sample");
check(
	quantile([Number.NaN, Number.NaN], 0.5) === null,
	"quantile is null when every value is NaN",
);
check(quantile([1, 2, 3, 4], 0) === 1, "quantile at p = 0 is the minimum");
check(near(quantile([1, 2, 3, 4], 0.5), 2.5), "quantile at p = 0.5 interpolates an even sample");
check(quantile([1, 2, 3, 4], 1) === 4, "quantile at p = 1 is the maximum");
check(
	near(quantile([4, 1, 3, 2], 0.25), 1.75),
	"quantile sorts its input before interpolating",
);
check(quantile([1, 2, 3], 2) === 3, "quantile clamps p above 1");
check(quantile([1, 2, 3], -1) === 1, "quantile clamps p below 0");
check(
	quantile([1, Number.NaN, 3], 0.5) === 2,
	"quantile drops non-finite values instead of propagating NaN",
);
check(quantile([1, 2, 3], Number.NaN) == null, "quantile with a NaN probability is null");

const unsorted = [4, 1, 3, 2];
quantile(unsorted, 0.5);
check(
	unsorted.join(",") === "4,1,3,2",
	"quantile does not mutate the caller's array",
);

// --- median vs upperMedian ----------------------------------------------
check(near(median([1, 2, 3, 4]), 2.5), "median averages the middle pair");
check(upperMedian([1, 2, 3, 4]) === 3, "upperMedian takes the upper of the middle pair");
check(
	median([1, 2, 3, 4]) !== upperMedian([1, 2, 3, 4]),
	"median and upperMedian are visibly different on an even sample",
);
check(median([1, 2, 3]) === 2, "median of an odd sample is the middle value");
check(upperMedian([1, 2, 3]) === 2, "upperMedian of an odd sample is the middle value");
check(median([]) === null, "median([]) is null");
check(upperMedian([]) === null, "upperMedian([]) is null");
check(
	upperMedian([3, Number.NaN, 1, 2]) === 2,
	"upperMedian drops non-finite values",
);

// --- weightedQuantile ----------------------------------------------------
check(
	weightedQuantile(
		[
			{ value: 10, weight: 1 },
			{ value: 20, weight: 3 },
		],
		0.5,
	) === 20,
	"weightedQuantile respects the weights",
);
check(
	weightedQuantile(
		[
			{ value: 10, weight: 1 },
			{ value: 20, weight: 3 },
		],
		0.1,
	) === 10,
	"weightedQuantile resolves the low tail",
);
check(
	weightedQuantile(
		[
			{ value: 1, weight: 0 },
			{ value: 2, weight: -1 },
			{ value: 3, weight: 2 },
		],
		0.5,
	) === 3,
	"weightedQuantile ignores zero and negative weights",
);
check(
	weightedQuantile(
		[
			{ value: Number.NaN, weight: 5 },
			{ value: 4, weight: 1 },
		],
		0.5,
	) === 4,
	"weightedQuantile ignores non-finite values",
);
check(weightedQuantile([], 0.5) === null, "weightedQuantile is null on an empty sample");
check(
	weightedQuantile(
		[
			{ value: 1, weight: 0 },
			{ value: 2, weight: 0 },
		],
		0.5,
	) === null,
	"weightedQuantile is null when the total weight is zero",
);
check(
	weightedQuantile(
		[
			{ value: 1, weight: 1 },
			{ value: 2, weight: 1 },
		],
		5,
	) === 2,
	"weightedQuantile clamps p above 1",
);
check(
	weightedQuantile(
		[
			{ value: 1, weight: 1 },
			{ value: 2, weight: 1 },
		],
		-1,
	) === 1,
	"weightedQuantile clamps p below 0",
);

// --- no NaN escapes ------------------------------------------------------
const everyResult: Array<number | null> = [
	clamp(5, 0, 10),
	clamp(-5, 0, 10),
	clamp(15, 0, 10),
	quantile([1, 2, 3, 4], 0.5),
	quantile([], 0.5),
	median([]),
	median([1, 2]),
	upperMedian([]),
	upperMedian([1, 2]),
	weightedQuantile([], 0.5),
	weightedQuantile([{ value: 1, weight: 0 }], 0.5),
];
check(
	everyResult.every((value) => value === null || Number.isFinite(value)),
	"no primitive returns NaN or Infinity for the pinned cases",
);

// --- market-chart regression --------------------------------------------
// The exact long-term-rental rows behind the market-chart rent histogram when
// the shared median replaced the chart-specific one. The chart takes the
// observed value at floor(n / 2), so the even oplaty sample stays at 600; the
// interpolated midpoint would be 575 and silently change the displayed text.
const oplaty: readonly number[] = [
	550, 364, 300, 700, 50, 600, 600, 1300, 400, 800, 530, 610,
];
const rentPrices: readonly number[] = [
	2900, 1200, 2090, 1500, 2900, 2000, 2000, 3700, 2000, 2300,
	1800, 3600, 1900, 1200, 2500, 1500, 1300, 1300, 8000, 11067,
	2099, 3200, 4250, 5500, 1900, 3000, 4900, 3200, 3100, 3600,
	2900, 3200, 2699, 3000, 2700, 3000, 2600, 6900, 8900, 6000,
	3400, 5500, 7500, 2800, 5500, 3500, 900, 10000, 11800, 9500,
	5600, 8900, 4900, 2500, 6000, 3600, 4400, 6500, 4200, 3800,
	17400, 5900, 2100, 1800, 1200, 1600, 1500, 2700, 1500, 1490,
	3500, 3000, 2000, 3500, 1000, 2700, 1600, 1300, 1050, 1800,
	1300, 2000, 2000, 14000, 300, 1900, 3900, 1900, 3300,
];
const czynsze: readonly number[] = [
	550, 364, 300, 700, 50, 600, 600, 0, 1300, 0,
	400, 0, 0, 800, 0, 0, 530, 610, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const totals = rentPrices.map((price, index) => price + (czynsze[index] ?? 0));

check(rentPrices.length === czynsze.length, "pinned chart fixture rows line up");
check(oplaty.length === 12, "pinned oplaty sample is even-sized");
check(upperMedian(oplaty) === 600, "chart oplaty median stays 600");
check(near(median(oplaty), 575), "the interpolated oplaty median would be 575");
check(upperMedian(rentPrices) === 2900, "chart rent median stays 2900");
check(upperMedian(totals) === 3000, "chart total-cost median stays 3000");
check(
	[median(oplaty), median(rentPrices), median(totals), upperMedian(totals)].every(
		(value) => value !== null && Number.isFinite(value),
	),
	"chart medians are finite",
);

if (failures > 0) {
	console.error(`\n${failures} stats check(s) failed.`);
	process.exit(1);
}
console.log("\nAll stats checks passed.");
