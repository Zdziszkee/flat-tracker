/**
 * Regression guard for cached JSON feeds. Run with `bun run validate:server-cache`.
 *
 * A cached undefined used to reach Response.json as a 500 from
 * /api/market-charts. These checks pin the boundary behavior without opening
 * the database, so they stay fast enough for routine validation.
 */
import {
	invalidateCache,
	withCache,
	withJsonObjectCache,
} from "../src/lib/server-cache.ts";

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) failures++;
}

invalidateCache("validate:server-cache:undefined");
let undefinedRejected = false;
try {
	await withCache("validate:server-cache:undefined", 60_000, async () => undefined);
} catch {
	undefinedRejected = true;
}
check(undefinedRejected, "withCache rejects an undefined result");

const concurrentKey = "validate:server-cache:concurrent";
invalidateCache(concurrentKey);
let computeCalls = 0;
const computeOnce = async () => {
	computeCalls++;
	await new Promise((resolve) => setTimeout(resolve, 10));
	return { ok: true };
};
const concurrent = await Promise.all([
	withCache(concurrentKey, 60_000, computeOnce),
	withCache(concurrentKey, 60_000, computeOnce),
]);
check(
	concurrent.every((value) => value?.ok === true),
	"concurrent reads receive the pending value",
);
check(computeCalls === 1, "concurrent reads compute once");

const key = "validate:server-cache:json";
invalidateCache(key);
const payload = await withJsonObjectCache(key, 60_000, async () => ({
	ok: true,
	rows: [1, 2],
}));
check(
	Response.json(payload).status === 200,
	"cached JSON feed is Response.json-serializable",
);
const cached = await withJsonObjectCache(key, 60_000, async () => ({ ok: false }));
check(cached.ok === true, "cached JSON feed is reused within the TTL");

const badKey = "validate:server-cache:bigint";
invalidateCache(badKey);
let bigintRejected = false;
try {
	await withJsonObjectCache(badKey, 60_000, async () => ({ n: 1n }));
} catch {
	bigintRejected = true;
}
check(bigintRejected, "withJsonObjectCache rejects BigInt before caching");

if (failures > 0) {
	console.error(`${failures} server-cache check(s) FAILED.`);
	process.exitCode = 1;
}
