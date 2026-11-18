/**
 * One-off audit probe for the asking-to-transaction ratio.
 *
 * Prints, per segment and region, every quarter bucket (median asking zł/m²
 * of visible sale listings vs median RCN zł/m² in the same quarter) and the
 * ratio the valuation model actually uses (measured, or the documented
 * fallback when the sample is thin). Read-only: no writes, no crawl.
 *
 *   bunx tsx scripts/measure-asking-ratio.ts
 *   bunx tsx scripts/measure-asking-ratio.ts --segment flat --region malopolskie
 */
import {
	ASKING_RATIO_FALLBACK,
	ASKING_RATIO_MIN_SAMPLE,
	askingToTransactionRatio,
	measureAskingRatioBuckets,
	type AskingRatio,
} from "../src/lib/valuation/asking-ratio.ts";
import type { QualitySegment } from "../src/lib/valuation/quality-factor.ts";

const SEGMENTS: QualitySegment[] = ["flat", "house", "plot"];
const REGIONS = ["malopolskie", "slaskie", null] as const;

function argValue(name: string): string | null {
	const index = process.argv.indexOf(name);
	if (index < 0) return null;
	return process.argv[index + 1] ?? null;
}

function formatter(value: number, digits = 0): string {
	return value.toLocaleString("pl-PL", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
}

function printRatio(label: string, ratio: AskingRatio): void {
	const ratioText = ratio.ratio.toFixed(3);
	const sample = `n=${formatter(ratio.sampleListings)}/${formatter(ratio.sampleTransactions)}`;
	const suffix =
		ratio.source === "fallback"
			? `  fallback ${ASKING_RATIO_FALLBACK[ratio.segment].toFixed(2)} (` +
				`< ${ASKING_RATIO_MIN_SAMPLE} per bucket)`
			: "";
	console.log(
		`${label.padEnd(34)} ${ratioText}  ${sample.padEnd(20)} ${ratio.source}${suffix}`,
	);
}

async function main(): Promise<void> {
	const onlySegment = argValue("--segment") as QualitySegment | null;
	const onlyRegion = argValue("--region");
	const segments = onlySegment ? [onlySegment] : SEGMENTS;

	console.log("Asking-to-transaction ratio, measured from this database");
	console.log(
		"listings: visible sale offers (flag asking)  |  RCN: tracked-region transactions",
	);
	console.log("");

	for (const segment of segments) {
		const buckets = await measureAskingRatioBuckets(segment);
		console.log(`== ${segment} ==`);
		console.log(
			[
				"region".padEnd(12),
				"quarter".padEnd(8),
				"listings".padStart(9),
				"tx".padStart(9),
				"ask zł/m²".padStart(11),
				"tx zł/m²".padStart(11),
				"ratio".padStart(7),
				"used".padStart(6),
			].join("  "),
		);
		for (const bucket of buckets) {
			console.log(
				[
					bucket.region.padEnd(12),
					bucket.quarter.padEnd(8),
					formatter(bucket.sampleListings).padStart(9),
					formatter(bucket.sampleTransactions).padStart(9),
					formatter(bucket.listingMedian).padStart(11),
					formatter(bucket.transactionMedian).padStart(11),
					bucket.ratio.toFixed(3).padStart(7),
					(bucket.used ? "yes" : "no").padStart(6),
				].join("  "),
			);
		}
		console.log("");
		const regions = onlyRegion ? [onlyRegion] : REGIONS;
		for (const region of regions) {
			const ratio = await askingToTransactionRatio(segment, region);
			printRatio(`applied ${region ?? "tracked (pooled)"}`, ratio);
		}
		console.log("");
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
