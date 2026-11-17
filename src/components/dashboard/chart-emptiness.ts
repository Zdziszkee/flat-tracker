import type { MarketCharts } from "#/types/market-charts";

/**
 * Chart-emptiness rules for the analytics grid. A chart whose rows are all
 * null/zero renders an explanatory placeholder instead of an empty axis, so
 * these checks mirror the series each chart actually draws.
 */

function hasFiniteValue(row: unknown, keys: readonly string[]): boolean {
	if (!row || typeof row !== "object") return false;
	const record = row as Record<string, unknown>;
	return keys.some((key) => {
		const value = record[key];
		return typeof value === "number" && Number.isFinite(value);
	});
}

function hasChartValues(
	rows: readonly unknown[] | undefined | null,
	yKeys: string | readonly string[],
	options: { requirePositive?: boolean } = {},
): boolean {
	if (!Array.isArray(rows)) return false;
	const keys = typeof yKeys === "string" ? [yKeys] : yKeys;
	return rows.some((row) =>
		keys.some((key) => {
			const value = (row as Record<string, unknown> | null)?.[key];
			if (typeof value !== "number" || !Number.isFinite(value)) return false;
			return options.requirePositive ? value > 0 : true;
		}),
	);
}

function hasNonZeroChartValues(
	rows: readonly unknown[] | undefined | null,
	yKeys: string | readonly string[],
): boolean {
	return hasChartValues(rows, yKeys, { requirePositive: true });
}

/** True when the chart for `key` has nothing to draw. */
export function isChartEmpty(key: string, data: MarketCharts): boolean {
	switch (key) {
		case "rentHistogram":
			return !hasNonZeroChartValues(data.rentHistogram, "n");
		case "oplatyHistogram":
			return !hasNonZeroChartValues(data.oplatyHistogram, "n");
		case "totalHistogram":
			return !hasNonZeroChartValues(data.totalHistogram, "n");
		case "priceTrend":
			return !hasChartValues(data.priceTrend, "avgM2");
		case "txVolume":
			return !hasNonZeroChartValues(data.txVolume, "tx");
		case "newSupply":
			return !["sprzedaż", "najem", "STR"].some((segment) =>
				hasNonZeroChartValues(
					data.newSupply?.filter((r) => r.segment === segment),
					"n",
				),
			);
		case "yoyByPowiat":
			return !hasChartValues(data.yoyByPowiat, "growthPct");
		case "grossYield":
			return !hasChartValues(data.grossYieldByCity, "yieldPct");
		case "offerVsTxGap":
			return !hasChartValues(data.offerVsTxGap, ["askM2", "txM2"]);
		case "primaryVsSecondary":
			return !hasChartValues(data.primaryVsSecondary, ["wtorny", "pierwotny"]);
		case "txByRooms":
			return !hasChartValues(data.txByRooms, "avgM2");
		case "areaSegments":
			return !hasChartValues(data.areaSegments, "avgM2");
		case "strPriceByMonth":
			return !["airbnb", "booking"].some((source) =>
				hasChartValues(
					data.strPriceByMonth?.filter((r) => r.source === source),
					"avgPrice",
				),
			);
		case "occupancyByMonth":
			return !hasChartValues(data.occupancyByMonth, "occupancy");
		case "weekdayPremium":
			return !hasChartValues(data.weekdayPremium, "avgPrice");
		case "strOccupancy":
			return !hasChartValues(data.strOccupancyByCity, "occupancy");
		case "occupancyVsYield": {
			const citiesWithOccupancy = new Set(
				(data.strOccupancyByCity ?? [])
					.filter((r) => hasFiniteValue(r, ["occupancy"]))
					.map((r) => r.city),
			);
			return !hasChartValues(
				(data.grossYieldByCity ?? []).filter((r) =>
					citiesWithOccupancy.has(r.city),
				),
				"yieldPct",
			);
		}
		case "nightlyByCity":
			return !["airbnb", "booking"].some((source) =>
				hasChartValues(
					data.nightlyByCity?.filter((r) => r.source === source),
					"avgNightly",
				),
			);
		case "priceDrops":
			return !hasNonZeroChartValues(data.priceDropsByCity, "dropPct");
		default:
			return false;
	}
}
