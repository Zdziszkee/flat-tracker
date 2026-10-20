import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import {
	getAreaSegments,
	getAskTrend,
	getGrossYieldByCity,
	getNewSupply,
	getNightlyByCity,
	getPriceDropsByCity,
	getRentHistograms,
} from "#/db/queries/market-charts/listings";
import {
	getOccupancyByMonth,
	getStrOccupancyByCity,
	getStrPriceByMonth,
	getWeekdayPremium,
} from "#/db/queries/market-charts/occupancy";
import {
	getPriceTrend,
	getPrimaryVsSecondary,
	getTxByRooms,
	getTxVolume,
	getYoyByPowiat,
} from "#/db/queries/market-charts/transactions";
import { withCache } from "#/lib/server-cache";

/**
 * Market-charts feed for the /analytics dashboard.
 *
 * The series live in `src/db/queries/market-charts/*`; this route only
 * orchestrates them and derives the two cross-series views (asking-vs-
 * transaction gap, occupancy-vs-yield). Queries stay sequential because
 * better-sqlite3 is synchronous: the shared `all` helper yields between them.
 */

async function computeMarketCharts() {
	const priceTrend = await getPriceTrend();
	const yoyByPowiat = await getYoyByPowiat();
	const txVolume = await getTxVolume();
	const primaryVsSecondary = await getPrimaryVsSecondary();
	const txByRooms = await getTxByRooms();
	const askTrend = await getAskTrend();
	const grossYieldByCity = await getGrossYieldByCity();
	const strOccupancyByCity = await getStrOccupancyByCity();
	const strPriceByMonth = await getStrPriceByMonth();
	const occupancyByMonth = await getOccupancyByMonth();
	const weekdayPremium = await getWeekdayPremium();
	const areaSegments = await getAreaSegments();
	const newSupply = await getNewSupply();
	const nightlyByCity = await getNightlyByCity();
	const priceDropsByCity = await getPriceDropsByCity();
	const rent = await getRentHistograms();

	const askMap = new Map(askTrend.map((row) => [row.month, row.avgM2]));
	const offerVsTxGap = priceTrend
		.filter((row) => askMap.has(row.month))
		.map((row) => {
			const ask = askMap.get(row.month) as number;
			return {
				month: row.month,
				askM2: Math.round(ask),
				txM2: Math.round(row.avgM2),
				gapPct: ((ask - row.avgM2) / row.avgM2) * 100,
			};
		});

	const occupancyMap = new Map(
		strOccupancyByCity.map((row) => [row.city, row.occupancy]),
	);
	const occupancyVsYield = grossYieldByCity
		.filter((row) => occupancyMap.has(row.city))
		.map((row) => ({
			city: row.city,
			yieldPct: row.yieldPct,
			occupancy: (occupancyMap.get(row.city) ?? 0) * 100,
		}));

	return {
		...rent,
		txByRooms,
		priceTrend,
		yoyByPowiat,
		txVolume,
		primaryVsSecondary,
		offerVsTxGap,
		grossYieldByCity,
		strOccupancyByCity,
		strPriceByMonth,
		occupancyByMonth,
		weekdayPremium,
		occupancyVsYield,
		areaSegments,
		newSupply,
		nightlyByCity,
		priceDropsByCity,
	};
}

export const Route = createFileRoute("/api/market-charts")({
	server: {
		handlers: {
			GET: async () =>
				json(await withCache("market-charts", 5 * 60_000, computeMarketCharts)),
		},
	},
});
