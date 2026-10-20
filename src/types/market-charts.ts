export interface HistogramBucket {
	label: string;
	n: number;
}

export interface MarketCharts {
	priceTrend: Array<{ month: string; avgM2: number; tx: number }>;
	yoyByPowiat: Array<{
		powiat: string;
		growthPct: number;
		recent: number | null;
		prior: number | null;
		tx: number;
	}>;
	txVolume: Array<{ month: string; tx: number }>;
	primaryVsSecondary: Array<{
		powiat: string;
		wtorny: number;
		pierwotny: number;
	}>;
	offerVsTxGap: Array<{
		month: string;
		askM2: number;
		txM2: number;
		gapPct: number;
	}>;
	grossYieldByCity: Array<{
		city: string;
		saleM2: number;
		rentM2: number;
		yieldPct: number;
		saleCount: number;
		rentCount: number;
	}>;
	strOccupancyByCity: Array<{
		city: string;
		occupancy: number;
		n: number;
	}>;
	strPriceByMonth: Array<{
		month: string;
		source: string;
		avgPrice: number;
	}>;
	occupancyByMonth: Array<{ month: string; occupancy: number }>;
	weekdayPremium: Array<{
		weekday: number;
		avgPrice: number;
		bookedShare: number;
	}>;
	occupancyVsYield: Array<{
		city: string;
		yieldPct: number;
		occupancy: number;
	}>;
	areaSegments: Array<{ label: string; avgM2: number; n: number }>;
	newSupply: Array<{ month: string; segment: string; n: number }>;
	nightlyByCity: Array<{
		city: string;
		source: string;
		avgNightly: number;
		n: number;
	}>;
	priceDropsByCity: Array<{
		city: string;
		dropped: number;
		total: number;
		dropPct: number;
	}>;
	rentHistogram: HistogramBucket[];
	rentMeta: { avg: number; median: number };
	oplatyHistogram: HistogramBucket[];
	oplatyMeta: { avg: number; median: number };
	totalHistogram: HistogramBucket[];
	totalMeta: { avg: number; median: number };
	txByRooms: Array<{ label: string; avgM2: number; n: number }>;
}

export interface ValuationRow {
	district: string;
	saleAvgM2: number;
	rentAvgM2: number;
	grossYieldPct: number;
	fairPriceM2: number;
	overUnderPct: number;
	paybackYears: number;
	valueScore: number;
}
