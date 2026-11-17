import { barY, defineChart, dot, lineY } from "@tanstack/charts";

import type { MarketCharts } from "#/types/market-charts";
import { bandX, CHART_THEME, linX, linY, SERIES } from "./chart-theme";

const DOW = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];

/**
 * Chart definitions for the analytics grid. Card metadata (title, subtitle,
 * key) lives in `analytics/chart-cards.ts`; this module only maps each key to
 * its marks/axes so the panel stays presentational.
 */
export function buildChartDefinitions(
	data: MarketCharts,
): Record<string, unknown> {
	const c: Record<string, unknown> = {};

	c.rentHistogram = defineChart({
		marks: [
			barY(data.rentHistogram, { x: "label", y: "n", fill: SERIES.blue }),
		],
		x: bandX("Czynsz mies. (zł)"),
		y: linY("liczba ofert"),
		theme: CHART_THEME,
	});
	c.oplatyHistogram = defineChart({
		marks: [
			barY(data.oplatyHistogram, {
				x: "label",
				y: "n",
				fill: SERIES.amber,
			}),
		],
		x: bandX("Czynsz adm. (zł)"),
		y: linY("liczba ofert"),
		theme: CHART_THEME,
	});
	c.totalHistogram = defineChart({
		marks: [
			barY(data.totalHistogram, { x: "label", y: "n", fill: SERIES.green }),
		],
		x: bandX("Czynsz + opłaty (zł/mies.)"),
		y: linY("liczba ofert"),
		theme: CHART_THEME,
	});
	c.priceTrend = defineChart({
		marks: [
			lineY(data.priceTrend, {
				x: "month",
				y: "avgM2",
				stroke: SERIES.violet,
				strokeWidth: 2,
			}),
		],
		x: bandX("Miesiąc"),
		y: linY("zł/m² (transakcje)"),
		theme: CHART_THEME,
	});
	c.txVolume = defineChart({
		marks: [barY(data.txVolume, { x: "month", y: "tx", fill: SERIES.blue })],
		x: bandX("Miesiąc"),
		y: linY("liczba transakcji"),
		theme: CHART_THEME,
	});
	const supplySale = data.newSupply.filter((r) => r.segment === "sprzedaż");
	const supplyRent = data.newSupply.filter((r) => r.segment === "najem");
	const supplyStr = data.newSupply.filter((r) => r.segment === "STR");
	c.newSupply = defineChart({
		marks: [
			lineY(supplySale, {
				x: "month",
				y: "n",
				stroke: SERIES.blue,
				strokeWidth: 2,
			}),
			lineY(supplyRent, {
				x: "month",
				y: "n",
				stroke: SERIES.emerald,
				strokeWidth: 2,
			}),
			lineY(supplyStr, {
				x: "month",
				y: "n",
				stroke: SERIES.rose,
				strokeWidth: 1.5,
			}),
		],
		x: bandX("Miesiąc"),
		y: linY("nowe oferty"),
		theme: CHART_THEME,
	});
	const yoySorted = [...data.yoyByPowiat].sort(
		(a, b) => (b.growthPct ?? 0) - (a.growthPct ?? 0),
	);
	c.yoyByPowiat = defineChart({
		marks: [
			barY(yoySorted, {
				x: "powiat",
				y: "growthPct",
				fill: (d) => ((d.growthPct ?? 0) >= 0 ? SERIES.green : SERIES.red),
			}),
		],
		x: bandX("Powiat"),
		y: linY("wzrost % r/r"),
		theme: CHART_THEME,
	});
	const yieldSorted = [...data.grossYieldByCity].sort(
		(a, b) => b.yieldPct - a.yieldPct,
	);
	c.grossYield = defineChart({
		marks: [
			barY(yieldSorted, {
				x: "city",
				y: "yieldPct",
				fill: SERIES.emerald,
			}),
		],
		x: bandX("Miasto"),
		y: linY("rentowność brutto %"),
		theme: CHART_THEME,
	});
	c.offerVsTxGap = defineChart({
		marks: [
			lineY(data.offerVsTxGap, {
				x: "month",
				y: "askM2",
				stroke: SERIES.blue,
				strokeWidth: 2,
			}),
			lineY(data.offerVsTxGap, {
				x: "month",
				y: "txM2",
				stroke: SERIES.violet,
				strokeWidth: 2,
			}),
		],
		x: bandX("Miesiąc"),
		y: linY("zł/m²"),
		theme: CHART_THEME,
	});
	c.primaryVsSecondary = defineChart({
		marks: [
			barY(data.primaryVsSecondary, {
				x: "powiat",
				y: "wtorny",
				fill: SERIES.slate,
			}),
			barY(data.primaryVsSecondary, {
				x: "powiat",
				y: "pierwotny",
				fill: SERIES.orange,
			}),
		],
		x: bandX("Powiat"),
		y: linY("zł/m²"),
		theme: CHART_THEME,
	});
	c.txByRooms = defineChart({
		marks: [
			barY(data.txByRooms, {
				x: "label",
				y: "avgM2",
				fill: SERIES.cyan,
			}),
		],
		x: bandX("Liczba pokoi"),
		y: linY("zł/m²"),
		theme: CHART_THEME,
	});
	c.areaSegments = defineChart({
		marks: [
			barY(data.areaSegments, {
				x: "label",
				y: "avgM2",
				fill: SERIES.cyan,
			}),
		],
		x: bandX("Metraż"),
		y: linY("zł/m²"),
		theme: CHART_THEME,
	});
	const abMonth = data.strPriceByMonth.filter((r) => r.source === "airbnb");
	const bkMonth = data.strPriceByMonth.filter((r) => r.source === "booking");
	c.strPriceByMonth = defineChart({
		marks: [
			lineY(abMonth, {
				x: "month",
				y: "avgPrice",
				stroke: SERIES.rose,
				strokeWidth: 2,
				points: true,
			}),
			lineY(bkMonth, {
				x: "month",
				y: "avgPrice",
				stroke: SERIES.booking,
				strokeWidth: 2,
				points: true,
			}),
		],
		x: bandX("Miesiąc"),
		y: linY("śr. zł/noc"),
		theme: CHART_THEME,
	});
	c.occupancyByMonth = defineChart({
		marks: [
			barY(data.occupancyByMonth, {
				x: "month",
				y: "occupancy",
				fill: SERIES.teal,
			}),
		],
		x: bandX("Miesiąc"),
		y: linY("obłożenie (0-1)"),
		theme: CHART_THEME,
	});
	const dowRows = data.weekdayPremium.map((r) => ({
		...r,
		day: DOW[r.weekday] ?? String(r.weekday),
	}));
	c.weekdayPremium = defineChart({
		marks: [barY(dowRows, { x: "day", y: "avgPrice", fill: SERIES.amber })],
		x: bandX("Dzień tygodnia (check-in)"),
		y: linY("śr. zł/noc"),
		theme: CHART_THEME,
	});
	const occSorted = [...data.strOccupancyByCity].sort(
		(a, b) => (b.occupancy ?? 0) - (a.occupancy ?? 0),
	);
	c.strOccupancy = defineChart({
		marks: [
			barY(occSorted, {
				x: "city",
				y: "occupancy",
				fill: SERIES.tealDeep,
			}),
		],
		x: bandX("Miasto"),
		y: linY("obłożenie (0-1)"),
		theme: CHART_THEME,
	});
	const occMap = new Map(
		data.strOccupancyByCity.map((r) => [r.city, r.occupancy]),
	);
	const scatterRows = data.grossYieldByCity
		.filter((r) => occMap.has(r.city))
		.map((r) => ({
			city: r.city,
			yieldPct: r.yieldPct,
			occupancy: (occMap.get(r.city) ?? 0) * 100,
		}));
	c.occupancyVsYield = defineChart({
		marks: [
			dot(scatterRows, {
				x: "occupancy",
				y: "yieldPct",
				r: 6,
				fill: SERIES.dotViolet,
			}),
		],
		x: linX("obłożenie STR %"),
		y: linY("rentowność LT %"),
		theme: CHART_THEME,
	});
	const nightlyAb = data.nightlyByCity.filter((r) => r.source === "airbnb");
	const nightlyBk = data.nightlyByCity.filter((r) => r.source === "booking");
	const cityOrder = [
		...new Set([...nightlyAb, ...nightlyBk].map((r) => r.city)),
	];
	c.nightlyByCity = defineChart({
		marks: [
			lineY(
				cityOrder.map((city) => ({
					city,
					avg: nightlyAb.find((r) => r.city === city)?.avgNightly ?? null,
				})),
				{
					x: "city",
					y: "avg",
					stroke: SERIES.rose,
					strokeWidth: 2,
					points: true,
				},
			),
			lineY(
				cityOrder.map((city) => ({
					city,
					avg: nightlyBk.find((r) => r.city === city)?.avgNightly ?? null,
				})),
				{
					x: "city",
					y: "avg",
					stroke: SERIES.booking,
					strokeWidth: 2,
					points: true,
				},
			),
		],
		x: bandX("Miasto"),
		y: linY("śr. zł/noc"),
		theme: CHART_THEME,
	});
	c.priceDrops = defineChart({
		marks: [
			barY(data.priceDropsByCity, {
				x: "city",
				y: "dropPct",
				fill: SERIES.red,
			}),
		],
		x: bandX("Miasto"),
		y: linY("% ofert z obniżką"),
		theme: CHART_THEME,
	});
	return c;
}
