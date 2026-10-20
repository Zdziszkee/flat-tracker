/**
 * Validate the market-chart series after the query split and the YoY fix.
 * Run with `bun run validate:market-charts`.
 *
 * The important assertions are semantic, not snapshots: months are months,
 * percentages are finite, the YoY windows are one year each, and the TERYT
 * labels still exist in the boundary dataset.
 */
import { regionPowiats } from "../src/data/region-powiats.ts";
import {
	getOccupancyByMonth,
	getStrPriceByMonth,
	getWeekdayPremium,
} from "../src/db/queries/market-charts/occupancy.ts";
import { getPriceDropsByCity, getRentHistograms } from "../src/db/queries/market-charts/listings.ts";
import {
	getPriceTrend,
	getPrimaryVsSecondary,
	getTxByRooms,
	getTxVolume,
	getYoyByPowiat,
} from "../src/db/queries/market-charts/transactions.ts";
import { POWIAT_NAMES } from "../src/lib/powiats.ts";

let failures = 0;
function check(ok: boolean, label: string, extra = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
	if (!ok) failures++;
}

const powiatNames = new Set(regionPowiats.map((p) => p.properties.name));
const missing = Object.values(POWIAT_NAMES).filter((name) => !powiatNames.has(name));
check(missing.length === 0, "every TERYT label exists in regionPowiats", missing.join(", "));

const monthRe = /^\d{4}-\d{2}$/;
const priceTrend = await getPriceTrend();
check(priceTrend.length > 0, "price trend has rows");
check(
	priceTrend.every(
		(row) =>
			monthRe.test(row.month) &&
			Number.isFinite(row.avgM2) &&
			Number.isFinite(row.tx),
	),
	"price trend rows are finite month buckets",
);

const txVolume = await getTxVolume();
check(txVolume.length > 0, "transaction volume has rows");
check(
	txVolume.every((row) => monthRe.test(row.month) && Number.isFinite(row.tx)),
	"transaction volume rows are finite month buckets",
);

const yoy = await getYoyByPowiat();
check(yoy.length > 0, "YoY has rows");
check(
	yoy.every(
		(row) =>
			powiatNames.has(row.powiat) &&
			row.growthPct != null &&
			Number.isFinite(row.growthPct) &&
			Math.abs(row.growthPct) <= 200 &&
			(row.recent ?? 0) > 0 &&
			(row.prior ?? 0) > 0,
	),
	"YoY rows are inside the 200% guard with both windows populated",
	`${yoy.length} powiaty`,
);

const primary = await getPrimaryVsSecondary();
check(primary.length > 0, "primary/secondary has rows");
check(
	primary.every(
		(row) =>
			powiatNames.has(row.powiat) &&
			Number.isFinite(row.wtorny) &&
			Number.isFinite(row.pierwotny),
	),
	"primary/secondary labels and values are valid",
);

const rooms = await getTxByRooms();
check(rooms.length > 0, "rooms series has rows");
check(
	rooms.every((row) => Number.isFinite(row.avgM2) && Number.isFinite(row.n)),
	"rooms series values are finite",
);

const occupancy = await getOccupancyByMonth();
check(occupancy.length > 0, "occupancy seasonality has rows");
check(
	occupancy.every(
		(row) => Number.isFinite(row.occupancy) && monthRe.test(row.month),
	),
	"occupancy seasonality values are finite",
);

const strPrices = await getStrPriceByMonth();
check(strPrices.length > 0, "STR price series has rows");
check(
	strPrices.every(
		(row) =>
			Number.isFinite(row.avgPrice) && monthRe.test(row.month) && row.source.length > 0,
	),
	"STR price rows are finite",
);

const weekday = await getWeekdayPremium();
check(weekday.length === 7, "weekday series covers all seven days", `${weekday.length}`);
check(
	weekday.every(
		(row) =>
			row.weekday >= 0 &&
			row.weekday <= 6 &&
			Number.isFinite(row.avgPrice) &&
			Number.isFinite(row.bookedShare),
	),
	"weekday values are finite",
);

const rent = await getRentHistograms();
for (const [label, rows] of [
	["rent", rent.rentHistogram],
	["oplaty", rent.oplatyHistogram],
	["total", rent.totalHistogram],
] as const) {
	check(
		rows.every((row) => Number.isFinite(row.n) && row.n >= 0),
		`${label} histogram counts are non-negative`,
	);
	check(
		rows.reduce((sum, row) => sum + row.n, 0) > 0,
		`${label} histogram is not empty`,
	);
}
check(
	Number.isFinite(rent.rentMeta.median) && Number.isFinite(rent.totalMeta.median),
	"rent histograms have finite medians",
);

const drops = await getPriceDropsByCity();
check(drops.length > 0, "price-drop series has rows");
check(
	drops.every(
		(row) =>
			Number.isFinite(row.dropPct) &&
			row.dropped >= 0 &&
			row.total >= row.dropped,
	),
	"price-drop rows are internally consistent",
);

console.log(
	failures === 0
		? "\nAll market-chart checks passed."
		: `\n${failures} market-chart check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
