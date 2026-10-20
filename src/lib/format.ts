/**
 * Display formatting shared by the map popups, the listings table, and the
 * analytics panels. Keeping the formatters here prevents the two screens
 * from rendering the same value differently.
 */

const pln = new Intl.NumberFormat("pl-PL", {
	style: "currency",
	currency: "PLN",
	maximumFractionDigits: 0,
});

const number = new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 });

export function formatPln(value: number | null | undefined): string {
	return value == null ? "n/d" : pln.format(value);
}

export function formatNumber(value: number | null | undefined): string {
	return value == null ? "" : number.format(value);
}

/** `pl-PL` date for a date string or a unix timestamp in seconds. */
export function formatDate(
	value: string | number | null | undefined,
	fallback = "",
): string {
	if (value == null) return fallback;
	const date =
		typeof value === "number" ? new Date(value * 1000) : new Date(value);
	return Number.isNaN(date.getTime())
		? fallback
		: date.toLocaleDateString("pl-PL");
}

/** Thread-post date; empty when the source carried no usable date. */
export function dateLabel(value?: string | null): string {
	return formatDate(value, "");
}

/** Four-digit year from a date string or a unix timestamp in seconds. */
export function yearOf(value: string | number | null | undefined): string {
	if (value == null) return "";
	if (typeof value === "number") {
		return new Date(value * 1000).getUTCFullYear().toString();
	}
	return value.slice(0, 4);
}

/**
 * Investmap's "realizacja" quarter is a planned completion, so the status
 * must stay factual: the quarter having passed is not proof of delivery.
 */
export function realizationCaption(
	label: string,
	date: string | null | undefined,
): string {
	let status = "";
	if (date) {
		const start = new Date(date);
		if (!Number.isNaN(start.getTime())) {
			const quarterEnd = new Date(start);
			quarterEnd.setMonth(quarterEnd.getMonth() + 3);
			status =
				quarterEnd.getTime() > Date.now()
					? " · w budowie"
					: " · planowany termin minął";
		}
	}
	return `Realizacja: ${label}${status}`;
}

/**
 * Render parsed utility/administrative fees as a short "Opłaty: ..." line.
 * The column is a JSON object, so a malformed value degrades to "".
 */
export function formatUtilities(json: string | null | undefined): string {
	if (!json) return "";
	try {
		const u = JSON.parse(json) as Record<string, unknown>;
		const parts: string[] = [];
		for (const [key, label] of [
			["czynsz", "czynsz"],
			["ogrzewanie", "ogrz."],
			["prad", "prąd"],
			["woda", "woda"],
			["gaz", "gaz"],
			["smieci", "śmieci"],
		] as const) {
			const value = u[key];
			if (typeof value === "number") parts.push(`${label} ${value} zł`);
		}
		return parts.length > 0 ? `Opłaty: ${parts.join(" · ")}` : "";
	} catch {
		return "";
	}
}
