import type { CheerioAdapter, CheerioSelection, Listing } from "../types.ts";
import {
	formatAddressForGeocode,
	isKnownKrakowStreet,
	parseAddressFromText,
	resolveStreetName,
} from "./address.ts";

/**
 * BudujeSie.pl — phpBB forum "Nowe inwestycje mieszkaniowe w Krakowie"
 * (bloki, apartamentowce, domy). One topic per investment: the title names
 * the investment, its street/quarter and usually the developer; the thread
 * carries construction updates. The site has no API and no embedded JSON —
 * it is plain prosilver phpBB markup, so DOM cards are enough.
 *
 * These rows are long-lived inventory (an investment stays "in progress"
 * for years), not fresh offers, so the adapter is `alwaysFullCrawl` like
 * komornik/investmap: every refresh re-syncs all 52 pages (~1,287 topics)
 * and ignores the `since` window. Discovery cannot rely on the first page
 * alone: the forum is sorted by last-post activity, so a topic created
 * years ago surfaces when someone bumps it. Rows are never pruned
 * (`pruneOldListings` only removes otodom/olx).
 *
 * Coordinates: the portal has none. The adapter mines a street address out
 * of the topic title (the strict shared parser first, then a forum-title
 * preprocessing pass) and falls back to the investment name as an
 * address-like locality, so `geocode-addresses` can place the row via the
 * local OSM street index or Photon. Rows that mine nothing stay unlocated
 * rather than piling onto the Kraków centroid.
 */

const BASE = "https://budujesie.pl";
const FORUM_PATH = "viewforum.php?f=5";

/** phpBB Polish month abbreviations ("25 wrz 2026, 12:44") and the full
 * genitive forms the locale uses for some months ("19 maja 2024"). */
const MONTHS: Record<string, number> = {
	sty: 1,
	stycznia: 1,
	lut: 2,
	lutego: 2,
	mar: 3,
	marca: 3,
	kwi: 4,
	kwie: 4,
	kwietnia: 4,
	maj: 5,
	maja: 5,
	cze: 6,
	czerwca: 6,
	lip: 7,
	lipca: 7,
	sie: 8,
	sierpnia: 8,
	wrz: 9,
	września: 9,
	paź: 10,
	paz: 10,
	października: 10,
	lis: 11,
	listopada: 11,
	gru: 12,
	grudnia: 12,
};

/** "25 wrz 2026, 12:44" -> "2026-09-25T12:44:00" (wall-clock, like portals). */
function parsePlDate(text: string | null | undefined): string | null {
	if (!text) return null;
	const cleaned = text.replace(/\s+/g, " ").trim();
	const pad = (n: string | number) => String(n).padStart(2, "0");
	// Recent posts are relative ("Dzisiaj, 10:00" / "Wczoraj, 15:03").
	const rel = cleaned.match(/\b(Dzisiaj|Wczoraj),?\s*(\d{1,2}):(\d{2})/iu);
	if (rel) {
		const base = new Date();
		if (/^wczoraj/iu.test(rel[1])) base.setDate(base.getDate() - 1);
		base.setHours(Number(rel[2]), Number(rel[3]), 0, 0);
		return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}:00`;
	}
	// Old topics drop the time ("19 maja 2024").
	const m = cleaned.match(
		/(\d{1,2})\s+([a-ząćęłńóśźż]{3,12})\s+(\d{4})(?:,\s*(\d{1,2}):(\d{2}))?/iu,
	);
	if (!m) return null;
	const month = MONTHS[m[2].toLowerCase()];
	if (!month) return null;
	return `${m[3]}-${pad(month)}-${pad(m[1])}T${pad(m[4] ?? 0)}:${pad(m[5] ?? 0)}:00`;
}

/** Leading int of "5 Odpowiedzi" / "1463 Odsłony". */
function countOf(text: string | null | undefined): number | null {
	const n = Number.parseInt(text ?? "", 10);
	return Number.isFinite(n) ? n : null;
}

/** Investment-type nouns that sit in front of the street in titles. */
const TYPE_NOISE_RE =
	/^(?:nowe\s+osiedle|osiedle|apartamenty|apartamentowiec|inwestycja|inwestycji|zesp[oó]w\s+mieszkaniowy|budynek|domy|dom|lokal)\s+/iu;

/**
 * Forum titles are semi-structured prose ("Inwestycja ul. Na Zjeździe
 * Kraków (obok placu Bohaterów Getta) / deweloper Reitcom - opinie na
 * forum"), so the strict shared parser misses streets it would catch in
 * ad text. Preprocess before retrying: cut commentary after " - ", drop
 * parentheticals and the bare city token, normalize "ulic X" (locative,
 * used in "na rogu ulic Parkowej i Potebni") to "ul. X", and strip the
 * investment-type noun that poisons the parser's word gate
 * ("Apartamenty Józefińska 16" -> "Józefińska 16").
 */
/**
 * The strict parser's greedy street capture happily runs past the street
 * into title prose ("Na Zjeździe Kraków", "Kalwaryjskiej i Władysława
 * Warneńczyka"). Cut the capture at the city token and at junction/boiler-
 * plate words, keeping the first street of a corner name, then resolve the
 * declension against the Krakow lexicon ("Kalwaryjskiej" -> "Kalwaryjska").
 */
function cutStreetTail(street: string): string {
	return street
		.replace(/\s+\bKrak[oó]w\w*\b.*$/iu, "")
		.replace(
			/\s+(?:i|oraz|od|dla|obok|naprzeciw|etap\w*|deweloper\w*|forum\w*|opinie\w*)\b.*$/iu,
			"",
		)
		.trim();
}

/** parseAddressFromText + tail cut + lexicon resolution. */
function parseTitleAddress(
	text: string,
): { street: string; number?: string } | null {
	const parsed = parseAddressFromText(text);
	if (!parsed) return null;
	const cut = cutStreetTail(parsed.street);
	if (!cut) return null;
	return cut === parsed.street
		? parsed
		: { street: resolveStreetName(cut), number: parsed.number };
}

function mineForumAddress(
	title: string,
): { street: string; number?: string } | null {
	const direct = parseTitleAddress(title);
	if (direct) return direct;

	const head = title.split(/\s+[-–—]\s+/u)[0] ?? title;
	const segments = head
		.replace(/[()]/gu, " ")
		.split(/\s*[/|]\s*/u)
		.map((s) => s.replace(/\s+/g, " ").trim())
		.filter(Boolean);

	for (const seg of segments) {
		const normalized = seg.replace(/\bulic(?=\s)/giu, "ul. ");
		const noType = normalized.replace(TYPE_NOISE_RE, "");
		const noCity = (s: string) =>
			s.replace(/\s+\bKrak[oó]w\w*\b.*$/iu, "").trim();
		for (const variant of [
			normalized,
			noType,
			noCity(normalized),
			noCity(noType),
		]) {
			const parsed = parseTitleAddress(variant.trim());
			if (parsed) return parsed;
		}
	}
	return null;
}

/**
 * Investment-name fallback ("Osiedle Kołłątajówka Kraków od Spravia" ->
 * "Kołłątajówka"): the head segment stripped of type nouns and the city
 * token, used as an address-like locality so Photon can place the estate.
 * Only single/two-word alphabetic names qualify — anything else stays
 * unlocated instead of geocoding garbage.
 */
function investmentNameFallback(title: string): string | null {
	const head = title.split(/\s+[-–—(]/u)[0] ?? title;
	const seg = (head.split(/\s*[/|]\s*/u)[0] ?? "").trim();
	const name = seg
		.replace(TYPE_NOISE_RE, "")
		.replace(/\s+\bKrak[oó]w\w*\b.*$/iu, "")
		.replace(/\s+/g, " ")
		.trim();
	const words = name.split(" ").filter(Boolean);
	if (words.length === 0 || words.length > 2) return null;
	if (!/^[A-ZĄĆĘŁŃÓŚŹŻ][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż.-]+$/.test(words[0]))
		return null;
	return name;
}

/** Małopolska towns that host whole investments ("Enklava Skawina").
 * Nominative form only; the resulting address geocodes to the town centre
 * via the locality fallback. */
const MAŁOPOLSKA_TOWNS = new Set([
	"Andrychów",
	"Bochnia",
	"Brzesko",
	"Chrzanów",
	"Dobczyce",
	"Kalwaria Zebrzydowska",
	"Kęty",
	"Krynica-Zdrój",
	"Krzeszowice",
	"Limanowa",
	"Miechów",
	"Myślenice",
	"Niepołomice",
	"Nowy Sącz",
	"Nowy Targ",
	"Olkusz",
	"Oświęcim",
	"Proszowice",
	"Rabka-Zdrój",
	"Skawina",
	"Sucha Beskidzka",
	"Szczawnica",
	"Tarnów",
	"Wadowice",
	"Wieliczka",
	"Wolbrom",
	"Zabierzów",
	"Zakopane",
]);

/** Last-resort town mining: the head segment naming a known town. */
function mineTownName(title: string): string | null {
	const head = (title.split(/\s+[-–—(]/u)[0] ?? "").replace(TYPE_NOISE_RE, " ");
	for (const word of head.split(/\s+/u)) {
		const clean = word.replace(/[.,;:]+$/u, "");
		if (MAŁOPOLSKA_TOWNS.has(clean)) return clean;
	}
	return null;
}

/**
 * Lexicon window, LAST resort after the name fallbacks: ad-speak name runs
 * ("Dobre Strony Obozowa") bury the street as one word among marketing
 * words. Accept a contiguous window only when it resolves to a KNOWN Krakow
 * street: a pair must exist as one lexicon name ("Kapelanka-Pychowicka"),
 * a single word must map to a real street ("obozowa" -> "Obozowa").
 */
function mineStreetWindow(title: string): string | null {
	const head = (title.split(/\s+[-–—(]/u)[0] ?? "").replace(TYPE_NOISE_RE, " ");
	const words = head
		.replace(/\s+\bKrak[oó]w\w*\b.*$/iu, "")
		.split(/\s+/u)
		.map((w) => w.replace(/[.,;:]+$/u, ""))
		.filter((w) => w.length >= 3);
	for (let size = 2; size >= 1; size--) {
		// Right-to-left: estate names usually put the street word last.
		for (let i = words.length - size; i >= 0; i--) {
			const window = words.slice(i, i + size);
			let candidate: string | null = null;
			if (size === 2) {
				const plain = window.map(resolveStreetName).join(" ");
				const hyphen = window.map(resolveStreetName).join("-");
				if (isKnownKrakowStreet(plain)) candidate = plain;
				else if (isKnownKrakowStreet(hyphen)) candidate = hyphen;
			} else {
				const resolved = resolveStreetName(window[0]);
				if (isKnownKrakowStreet(resolved)) candidate = resolved;
			}
			if (candidate) return candidate;
		}
	}
	return null;
}

/** "Kraków Podgórze" -> "Podgórze" (domiporta's heuristic). */
function extractDistrict(title: string): string | null {
	const m = title.match(/Krak[oó]w\s+([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż-]+)/u);
	return m ? m[1] : null;
}

export const budujesieAdapter: CheerioAdapter = {
	id: "budujesie",
	name: "BudujeSie.pl · inwestycje mieszkaniowe w budowie (Kraków)",
	kind: "cheerio",
	startUrls: [`${BASE}/${FORUM_PATH}`],
	// 52 pages today; headroom for the forum to grow.
	maxRequestsPerCrawl: 70,
	// Re-sync the whole list every run (komornik precedent).
	alwaysFullCrawl: true,
	listingSelector: "ul.topiclist.topics li.row",
	// Scoped to the forum-level pagination: topic rows embed their own
	// page-number links inside `.list-inner .pagination`, which must never
	// be enqueued as forum pages.
	nextPageSelector: ".action-bar .pagination li.next a",

	parseListingCard($: CheerioSelection, el: unknown): Listing | null {
		const $el = $(el as never);
		// The announcements block reuses the same row markup; only real
		// topics are investments.
		if (/\bannounce\b/u.test($el.attr("class") ?? "")) return null;

		const href = $el.find("a.topictitle").attr("href");
		const title = $el.find("a.topictitle").text().trim();
		if (!href || !title) return null;

		const topicId = new URL(href, BASE).searchParams.get("t");
		if (!topicId) return null;
		const url = `${BASE}/viewtopic.php?${new URLSearchParams({
			f: "5",
			t: topicId,
		}).toString()}`;

		// Topic start ("autor: Master » 25 wrz 2026, 12:44") is only in the
		// non-responsive author line; the responsive variant repeats the
		// LAST post date instead, so target `.responsive-hide` precisely.
		const metaText = $el.find(".responsive-hide").text();
		const listedAt = parsePlDate(metaText);
		const author =
			metaText.match(/autor:\s*([^»]+?)\s*»/u)?.[1]?.trim() ?? null;
		const lastPostAt = parsePlDate($el.find("dd.lastpost").text());
		const replies = countOf($el.find("dd.posts").text());
		const views = countOf($el.find("dd.views").text());

		const district = extractDistrict(title);
		const mined = mineForumAddress(title);
		let address = mined
			? formatAddressForGeocode(mined.street, mined.number, district)
			: null;
		if (!address) {
			const name = mineTownName(title) ?? investmentNameFallback(title);
			if (name) address = formatAddressForGeocode(name, undefined, district);
		}
		if (!address) {
			const street = mineStreetWindow(title);
			if (street)
				address = formatAddressForGeocode(street, undefined, district);
		}

		const features: Record<string, unknown> = {};
		if (author) features.author = author;
		if (replies != null) features.replies = replies;
		if (views != null) features.views = views;
		if (lastPostAt) features.lastPostAt = lastPostAt;

		return {
			source: this.id,
			externalId: topicId,
			url,
			title,
			price: null,
			pricePerM2: null,
			areaM2: null,
			rooms: null,
			floor: null,
			district,
			address,
			description: null,
			heatingType: null,
			propertyType: "inwestycja",
			features:
				Object.keys(features).length > 0 ? JSON.stringify(features) : null,
			lat: null,
			lng: null,
			listedAt,
			scrapedAt: new Date().toISOString(),
		};
	},
};
