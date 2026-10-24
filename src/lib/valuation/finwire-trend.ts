/**
 * Pure parsing/chaining for the finwire.pl city price pages.
 *
 * Kept DB- and framework-free so `scripts/validate-finwire.ts` can pin the
 * `ng-state` extraction and the chain math without opening SQLite.
 */

export interface TrendPoint {
	quarter: string;
	medianM2: number;
	n: number;
}

export interface FinwireCityData {
	slug: string;
	name: string;
	latestQuarter: string;
	firstQuarter: string;
	trend: TrendPoint[];
}

export interface ChainedPoint {
	quarter: string;
	indexValue: number;
	medianM2: number;
	n: number;
}

/**
 * Pull the `ng-state` JSON out of a finwire city page and return the
 * `cm-rcn-city:<slug>` payload. Returns null when the page has no such key
 * (a 404 city page still renders the shell, so absence is the failure mode).
 */
export function parseFinwireCityPage(
	html: string,
	slug: string,
): FinwireCityData | null {
	const match = html.match(
		/<script[^>]*id="ng-state"[^>]*>([\s\S]*?)<\/script>/iu,
	);
	if (!match?.[1]) return null;
	let state: Record<string, unknown>;
	try {
		state = JSON.parse(match[1]) as Record<string, unknown>;
	} catch {
		return null;
	}
	const raw = state[`cm-rcn-city:${slug}`];
	if (!raw || typeof raw !== "object") return null;
	const data = raw as {
		slug?: unknown;
		name?: unknown;
		latestQuarter?: unknown;
		firstQuarter?: unknown;
		trend?: unknown;
	};
	if (typeof data.slug !== "string" || data.slug !== slug) return null;
	if (typeof data.latestQuarter !== "string") return null;
	if (!Array.isArray(data.trend)) return null;
	const trend: TrendPoint[] = [];
	for (const point of data.trend) {
		if (!point || typeof point !== "object") continue;
		const entry = point as {
			quarter?: unknown;
			medianM2?: unknown;
			n?: unknown;
		};
		if (typeof entry.quarter !== "string") continue;
		const medianM2 = Number(entry.medianM2);
		const n = Number(entry.n);
		if (!Number.isFinite(medianM2) || medianM2 <= 0) continue;
		trend.push({
			quarter: entry.quarter,
			medianM2,
			n: Number.isFinite(n) && n > 0 ? n : 0,
		});
	}
	if (trend.length < 2) return null;
	return {
		slug,
		name: typeof data.name === "string" ? data.name : slug,
		latestQuarter: data.latestQuarter,
		firstQuarter:
			typeof data.firstQuarter === "string" ? data.firstQuarter : "",
		trend,
	};
}

/**
 * Chain the quarterly medians into a base-100 index (first usable quarter
 * = 100). A >2x or <0.5x quarterly jump is skipped as a contaminated
 * observation, mirroring `chainStratifiedIndex`; the next valid quarter then
 * links from the last accepted point, so the series keeps its continuity
 * instead of absorbing the outlier.
 */
export function chainCityTrend(trend: readonly TrendPoint[]): ChainedPoint[] {
	const sorted = [...trend]
		.filter((point) => point.medianM2 > 0)
		.sort((a, b) => a.quarter.localeCompare(b.quarter));
	const out: ChainedPoint[] = [];
	let previous: ChainedPoint | null = null;
	for (const point of sorted) {
		if (!previous) {
			previous = {
				quarter: point.quarter,
				indexValue: 100,
				medianM2: point.medianM2,
				n: point.n,
			};
			out.push(previous);
			continue;
		}
		const change = point.medianM2 / previous.medianM2;
		if (change <= 0.5 || change >= 2) continue;
		const next: ChainedPoint = {
			quarter: point.quarter,
			indexValue: previous.indexValue * change,
			medianM2: point.medianM2,
			n: point.n,
		};
		out.push(next);
		previous = next;
	}
	return out;
}
