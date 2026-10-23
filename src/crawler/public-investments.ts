import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "#/db/index";
import { publicInvestments } from "#/db/schema";
import { categorizePublicInvestment } from "#/lib/public-investments";
import { cleanText, decodeHtmlEntities } from "./sites/html-entities.ts";

/**
 * Planned and completed public investments published as Google My Maps
 * KML by the City of Kraków (roads, schools, parks, sport, culture).
 *
 * The city maintains two maps:
 * - "Inwestycje Planowane 2019 i lata następne"
 * - "Mapa Inwestycji Miejskich" (completed)
 *
 * Each placemark is a point with a name and a rich HTML description
 * (location, scope, planned/actual delivery year). There is no official
 * per-project page or API, so the KML export is the machine-readable form.
 * National road/rail programmes (GDDKiA, PKP PLK/KPK) do not publish
 * georeferenced project records; they are documented in AGENTS.md as
 * research sources rather than imported here.
 */

const PLANNED_KML =
	"https://www.google.com/maps/d/kml?mid=1kDtYUdnJc4vnTp19AlVc6pbxBTA3C218&forcekml=1";
const COMPLETED_KML =
	"https://www.google.com/maps/d/kml?mid=1Z2HQtKfvPGgjCcbuLY6s6aZdukjl6zGf&forcekml=1";
const PLANNED_VIEW =
	"https://www.google.com/maps/d/viewer?mid=1kDtYUdnJc4vnTp19AlVc6pbxBTA3C218";
const COMPLETED_VIEW =
	"https://www.google.com/maps/d/viewer?mid=1Z2HQtKfvPGgjCcbuLY6s6aZdukjl6zGf";
const SOURCE = "krakow-mmp";
const STATE_PATH = "data/crawler/public-investments-state.json";
const REFRESH_DAYS = 7;

interface KmlPlace {
	name: string;
	description: string | null;
	lat: number;
	lng: number;
}

interface ImportResult {
	skipped: boolean;
	planned: number;
	completed: number;
	inserted: number;
	updated: number;
}

function tagText(block: string, tag: string): string | null {
	const match = block.match(
		new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "iu"),
	);
	return match?.[1] ?? null;
}

function textOf(raw: string | null): string | null {
	if (!raw) return null;
	const withoutCdata = raw
		.replace(/^\s*<!\[CDATA\[/u, "")
		.replace(/\]\]>\s*$/u, "");
	const decoded = decodeHtmlEntities(withoutCdata)
		.replace(/<br\s*\/?>/giu, "\n")
		.replace(/<[^>]+>/gu, " ");
	return cleanText(decoded);
}

/** One KML document's point placemarks (the city maps are point-only). */
export function parseKml(kml: string): KmlPlace[] {
	const places: KmlPlace[] = [];
	for (const match of kml.matchAll(
		/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/giu,
	)) {
		const block = match[1] ?? "";
		const name = textOf(tagText(block, "name"));
		if (!name) continue;
		const coordinates = textOf(tagText(block, "coordinates"));
		if (!coordinates) continue;
		const [lngRaw, latRaw] = coordinates.split(",");
		const lng = Number(lngRaw);
		const lat = Number(latRaw);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		places.push({
			name,
			description: textOf(tagText(block, "description")),
			lat,
			lng,
		});
	}
	return places;
}

/** Explicit delivery-year phrase first; otherwise a plausible 1990-2035 year. */
export function investmentYear(description: string | null): number | null {
	if (!description) return null;
	const explicit = description.match(
		/(?:planowany termin oddania do u[żz]ytkowania|rok oddania|oddano do u[żz]ytkowania|realizacja)[^0-9]{0,50}((?:19|20)\d{2})/iu,
	);
	if (explicit) return Number(explicit[1]);
	for (const match of description.matchAll(/\b((?:19|20)\d{2})\b/gu)) {
		const year = Number(match[1]);
		if (year >= 1990 && year <= 2035) return year;
	}
	return null;
}

function externalIdOf(place: KmlPlace): string {
	return createHash("sha1")
		.update(`${place.name}|${place.lat.toFixed(6)}|${place.lng.toFixed(6)}`)
		.digest("hex")
		.slice(0, 20);
}

async function fetchKml(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (compatible; flat-tracker/1.0; +https://github.com/Zdziszkee/flat-tracker)",
		},
	});
	if (!response.ok) {
		throw new Error(`KML HTTP ${response.status} for ${url}`);
	}
	return response.text();
}

function loadState(): { lastImportedAt: string | null } {
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
			lastImportedAt: string | null;
		};
	} catch {
		return { lastImportedAt: null };
	}
}

function saveState(lastImportedAt: string, result: ImportResult): void {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(
		STATE_PATH,
		JSON.stringify({
			lastImportedAt,
			planned: result.planned,
			completed: result.completed,
			inserted: result.inserted,
			updated: result.updated,
		}),
	);
}

function toRow(
	place: KmlPlace,
	status: "planned" | "completed",
	mapUrl: string,
	now: Date,
) {
	const text = `${place.name} ${place.description ?? ""}`;
	const nameCategory = categorizePublicInvestment(place.name);
	return {
		source: SOURCE,
		externalId: externalIdOf(place),
		name: place.name,
		// The name is the best signal; a school mentioned only in a park
		// project's description must not turn it into a school.
		category:
			nameCategory === "other"
				? categorizePublicInvestment(text)
				: nameCategory,
		status,
		description: place.description ? place.description.slice(0, 2000) : null,
		url: mapUrl,
		lat: place.lat,
		lng: place.lng,
		geometry: null,
		year: investmentYear(place.description),
		city: "Kraków",
		region: "małopolskie",
		lastSeenAt: now,
		scrapedAt: now,
	};
}

/**
 * Import the city's two KML maps into `public_investments`. The source is
 * a complete dump, so rows not present in this run are deleted after a
 * short grace period (a failed fetch leaves the previous rows intact).
 */
export async function importPublicInvestments(
	opts: { force?: boolean } = {},
): Promise<ImportResult> {
	const state = loadState();
	if (
		!opts.force &&
		state.lastImportedAt &&
		Date.now() - Date.parse(state.lastImportedAt) < REFRESH_DAYS * 86_400_000
	) {
		return {
			skipped: true,
			planned: 0,
			completed: 0,
			inserted: 0,
			updated: 0,
		};
	}

	const settled = await Promise.allSettled([
		fetchKml(PLANNED_KML),
		fetchKml(COMPLETED_KML),
	]);
	const plannedKml =
		settled[0].status === "fulfilled" ? settled[0].value : null;
	const completedKml =
		settled[1].status === "fulfilled" ? settled[1].value : null;
	if (!plannedKml && !completedKml) {
		throw new Error("public investments: both KML downloads failed");
	}
	if (!plannedKml) {
		console.warn(
			`[public-investments] planned KML failed: ${String((settled[0] as PromiseRejectedResult).reason)}`,
		);
	}
	if (!completedKml) {
		console.warn(
			`[public-investments] completed KML failed: ${String((settled[1] as PromiseRejectedResult).reason)}`,
		);
	}

	const now = new Date();
	const planned = plannedKml ? parseKml(plannedKml) : [];
	const completed = completedKml ? parseKml(completedKml) : [];
	const rows = [
		...planned.map((place) => toRow(place, "planned", PLANNED_VIEW, now)),
		// Imported second so a project present in both maps is marked completed.
		...completed.map((place) => toRow(place, "completed", COMPLETED_VIEW, now)),
	];

	const existing = await db
		.select({ externalId: publicInvestments.externalId })
		.from(publicInvestments)
		.where(eq(publicInvestments.source, SOURCE));
	const existingIds = new Set(existing.map((row) => row.externalId));
	const inserted = rows.filter(
		(row) => !existingIds.has(row.externalId),
	).length;
	const updated = rows.length - inserted;

	const BATCH = 200;
	for (let i = 0; i < rows.length; i += BATCH) {
		const chunk = rows.slice(i, i + BATCH);
		await db
			.insert(publicInvestments)
			.values(chunk)
			.onConflictDoUpdate({
				target: [publicInvestments.source, publicInvestments.externalId],
				set: {
					name: sql`excluded.name`,
					category: sql`excluded.category`,
					status: sql`excluded.status`,
					description: sql`excluded.description`,
					url: sql`excluded.url`,
					lat: sql`excluded.lat`,
					lng: sql`excluded.lng`,
					geometry: sql`excluded.geometry`,
					year: sql`excluded.year`,
					city: sql`excluded.city`,
					region: sql`excluded.region`,
					lastSeenAt: sql`excluded.last_seen_at`,
					scrapedAt: sql`excluded.scraped_at`,
				},
			});
	}

	// Complete-dump pruning: only when both maps were fetched, so a single
	// failed request cannot delete half the layer.
	if (plannedKml && completedKml) {
		const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
		await db
			.delete(publicInvestments)
			.where(
				and(
					eq(publicInvestments.source, SOURCE),
					lt(publicInvestments.lastSeenAt, cutoff),
				),
			);
	}

	const result: ImportResult = {
		skipped: false,
		planned: planned.length,
		completed: completed.length,
		inserted,
		updated,
	};
	saveState(now.toISOString(), result);
	return result;
}
