/**
 * Shared vocabulary for the planned/completed public-investment layer.
 * The importer classifies free-text city projects into these buckets; the
 * map colors points by the same keys and the popup prints the label.
 */

export type PublicInvestmentCategory =
	| "road"
	| "rail"
	| "school"
	| "park"
	| "sport"
	| "culture"
	| "health"
	| "other";

export type PublicInvestmentStatus = "planned" | "in_progress" | "completed";

export const PUBLIC_INVESTMENT_CATEGORY_LABELS: Record<
	PublicInvestmentCategory,
	string
> = {
	road: "Drogi",
	rail: "Kolej",
	school: "Edukacja",
	park: "Parki i zieleń",
	sport: "Sport",
	culture: "Kultura",
	health: "Zdrowie",
	other: "Inne",
};

export const PUBLIC_INVESTMENT_CATEGORY_COLORS: Record<
	PublicInvestmentCategory,
	string
> = {
	road: "#f97316",
	rail: "#0ea5e9",
	school: "#16a34a",
	park: "#84cc16",
	sport: "#e11d48",
	culture: "#a855f7",
	health: "#dc2626",
	other: "#64748b",
};

export const PUBLIC_INVESTMENT_STATUS_LABELS: Record<
	PublicInvestmentStatus,
	string
> = {
	planned: "Planowane",
	in_progress: "W realizacji",
	completed: "Zrealizowane",
};

const CATEGORY_RULES: Array<[PublicInvestmentCategory, RegExp]> = [
	[
		"school",
		/szko[łl]|przedszkol|liceum|technik|uczelni|żłobek|zlobek|zesp[oó]?[łl] szkolno|akademi/iu,
	],
	[
		"culture",
		/muzeum|bibliotek|centrum kultury|teatr|dom kultury|filharmoni|muzyki|galeri|kin(o|a)\b/iu,
	],
	["health", /szpital|przychod|klinik|centrum medyczne|medyczn/iu],
	[
		"rail",
		/linia kolejow|linii kolejow|torowisk|pkp|peron|przystanek kolejow|tramwaj|metro\b|centrum komunikacyjn/iu,
	],
	[
		"sport",
		/basen|p[łl]ywalni|hala sport|boisko|stadion|sport|korty|si[łl]owni/iu,
	],
	["park", /park|skwer|planty|bulwar|ogr[oó]d|zieleni/iu],
	[
		"road",
		/ulic|ul\.|droga|drogi|tras[ay]|węze[łl]|wiadukt|estakad|obwodnic|rondo|k[łl]adk|przebudow|rozbudow|budow[ay]/iu,
	],
];

export function categorizePublicInvestment(
	text: string,
): PublicInvestmentCategory {
	for (const [category, pattern] of CATEGORY_RULES) {
		if (pattern.test(text)) return category;
	}
	return "other";
}

export function categoryLabel(value: string): string {
	return (
		PUBLIC_INVESTMENT_CATEGORY_LABELS[value as PublicInvestmentCategory] ??
		value
	);
}

export function categoryColor(value: string): string {
	return (
		PUBLIC_INVESTMENT_CATEGORY_COLORS[value as PublicInvestmentCategory] ??
		PUBLIC_INVESTMENT_CATEGORY_COLORS.other
	);
}

export function statusLabel(value: string): string {
	return (
		PUBLIC_INVESTMENT_STATUS_LABELS[value as PublicInvestmentStatus] ?? value
	);
}
