/**
 * Regression checks for `src/lib/error-report.ts`.
 *
 * The failure this guards against is the reason the helper exists: an Effect
 * `FiberFailure` whose own message is "An error has occurred" while the real
 * cause (and its stack) sits in the failure's cause. If this script goes red,
 * /sources is back to showing a useless one-liner.
 *
 * Runs without a database or the network: `bun run validate:errors`.
 */
import { Data, Effect } from "effect";

import { briefError, errorReport } from "../src/lib/error-report.ts";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
	if (ok) {
		console.log(`PASS  ${name}`);
		return;
	}
	failures++;
	console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
}

class CrawlError extends Data.TaggedError("CrawlError")<{
	site: string;
	cause: unknown;
}> {}

/** The exact shape `Effect.runPromise` throws for a `CrawlError`. */
async function thrownFiberFailure(cause: unknown): Promise<unknown> {
	try {
		await Effect.runPromise(
			Effect.fail(new CrawlError({ site: "booking", cause })) as Effect.Effect<never>,
		);
	} catch (error) {
		return error;
	}
	throw new Error("the effect should have failed");
}

// 1. Effect FiberFailure: the shallow message is generic, the cause is not.
const fiber = await thrownFiberFailure(
	new Error("playwright: Executable doesn't exist at /x/chrome"),
);
const fiberBrief = briefError(fiber);
check(
	"fiber failure briefs the real cause",
	fiberBrief.includes("Executable doesn't exist"),
	JSON.stringify(fiberBrief),
);
check(
	"fiber failure does not brief the generic message",
	fiberBrief !== "An error has occurred",
	fiberBrief,
);

const fiberReport = errorReport(fiber, 'crawl of "booking" failed');
check(
	"report message carries the context and the cause",
	fiberReport.message.startsWith('crawl of "booking" failed: ') &&
		fiberReport.message.includes("Executable doesn't exist"),
	fiberReport.message,
);
check(
	"report detail lists the cause chain",
	fiberReport.detail.includes("cause chain:") &&
		fiberReport.detail.includes("FiberFailureImpl") &&
		fiberReport.detail.includes("Executable doesn't exist"),
	fiberReport.detail.slice(0, 200),
);
check(
	"report detail keeps a stack trace",
	fiberReport.detail.includes("stack:") &&
		fiberReport.detail.includes("    at "),
	fiberReport.detail.slice(0, 200),
);

// 2. Nested Node error chain: the deepest message wins.
const nested = new Error("outer", {
	cause: new Error("middle", { cause: new Error("root cause") }),
});
check("node chain briefs the root cause", briefError(nested) === "root cause");
const nestedReport = errorReport(nested);
check(
	"node chain detail lists every link",
	["outer", "middle", "root cause"].every((m) => nestedReport.detail.includes(m)),
	nestedReport.detail.slice(0, 200),
);

// 3. Plain values.
check(
	"plain string stays readable",
	briefError("finwire: no city page could be parsed") ===
		"finwire: no city page could be parsed",
);
check("non-error values fall back", briefError({ nope: true }) === "unknown error");
check("null falls back", briefError(null) === "unknown error");

// 4. A generic-only failure still yields the generic text, never empty.
const genericOnly = await thrownFiberFailure(undefined);
check("generic-only failure is non-empty", briefError(genericOnly).length > 0);

// 5. Details are bounded and colour-free.
const long = new Error("x".repeat(20_000));
const longDetail = errorReport(long).detail;
check("detail is truncated", longDetail.length <= 9_000, String(longDetail.length));
check(
	"detail has no ANSI escapes",
	!/\u001b\[/u.test(fiberReport.detail + longDetail),
);

// 6. Context is optional and never duplicated.
check(
	"no context keeps the bare message",
	errorReport(new Error("bare")).message === "bare",
);

if (failures > 0) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nALL PASS");
