import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * Coordinates: the portal has none. The topic's first post states the
 * real location in prose ("powstaje przy ul. Magnoliowej 8 w Wieliczce"),
 * so the thread fetch mines the address out of the post text first and the
 * title mining above is only the fallback. The same fetch stores the
 * posts (the investment description plus the comments under it) in the
 * listing's features JSON for the map popup and the listings panel.
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

/** Diacritic-insensitive lowercase for name/town comparisons. */
function foldForCompare(s: string): string {
	return s
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase();
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
		.replace(/\s+\bk\.?$/iu, "")
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

/**
 * Town mining: a known town in the title ("Inwestycja Magnoliowa -
 * Wieliczka", "Enklava Skawina"). Head segment first for precision, then
 * the whole title — forum titles put the town after a " - " commentary
 * split often enough that the head alone lost it ("Pod Jabłoniami -
 * Tarnów" geocoded with the default city and landed in Kraków).
 */
function mineTownName(title: string): string | null {
	const head = (title.split(/\s+[-–—(]/u)[0] ?? "").replace(TYPE_NOISE_RE, " ");
	for (const segment of [head, title]) {
		for (const word of segment.split(/\s+/u)) {
			const clean = word.replace(/^[("'«]+/u, "").replace(/[.,;:)]+$/u, "");
			if (MAŁOPOLSKA_TOWNS.has(clean)) return clean;
		}
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

/** Card rows on a forum list page. */
const LIST_SELECTOR = "ul.topiclist.topics li.row";
/** Scoped to the forum-level pagination: topic rows embed their own
 * page-number links inside `.list-inner .pagination`, which must never
 * be enqueued as forum pages. */
const NEXT_PAGE_SELECTOR = ".action-bar .pagination li.next a";

/** One forum post (the topic description or a comment under it). */
export interface ThreadPost {
	author: string | null;
	at: string | null;
	text: string;
}

interface CachedTopic {
	lastPostAt: string | null;
	address: string | null;
	description: string | null;
	posts: ThreadPost[];
}

let topicCacheState: Record<string, CachedTopic> | null = null;

/** Thread-page enrichment cache (data/crawler/budujesie-topics.json,
 * overridable via BUDUJESIE_TOPIC_CACHE for the fixture harness): keyed by
 * topic id, it records what the last successful thread fetch saw
 * (`lastPostAt`) so re-crawls only fetch topics whose thread moved, and
 * what it learned (OP-mined address, description, posts) so list-page rows
 * keep the enrichment without a refetch. */
function topicCachePath(): string {
	return (
		process.env.BUDUJESIE_TOPIC_CACHE ?? "data/crawler/budujesie-topics.json"
	);
}

function loadTopicCache(): Record<string, CachedTopic> {
	if (topicCacheState) return topicCacheState;
	let parsed: Record<string, Partial<CachedTopic>> = {};
	try {
		parsed = JSON.parse(readFileSync(topicCachePath(), "utf8"));
	} catch {
		// Missing or corrupt cache: start empty, threads simply re-fetch.
	}
	const cache: Record<string, CachedTopic> = {};
	for (const [id, entry] of Object.entries(parsed)) {
		cache[id] = {
			lastPostAt: entry.lastPostAt ?? null,
			address: entry.address ?? null,
			description: entry.description ?? null,
			posts: Array.isArray(entry.posts) ? entry.posts : [],
		};
	}
	topicCacheState = cache;
	return cache;
}

function saveTopicCache(cache: Record<string, CachedTopic>): void {
	const path = topicCachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(cache));
}

function parseFeaturesJson(s: string | null): Record<string, unknown> {
	if (!s) return {};
	try {
		const v: unknown = JSON.parse(s);
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Cards on a forum list page (kept exported: the validator runs pinned
 * fixtures through it and `extractHtml` re-emits cards through it). */
export function parseTopicCard(
	$: CheerioSelection,
	el: unknown,
): Listing | null {
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
	const author = metaText.match(/autor:\s*([^»]+?)\s*»/u)?.[1]?.trim() ?? null;
	const lastPostAt = parsePlDate($el.find("dd.lastpost").text());
	const replies = countOf($el.find("dd.posts").text());
	const views = countOf($el.find("dd.views").text());

	const district = extractDistrict(title);
	const town = mineTownName(title);
	// A street in another małopolska town must not carry the Kraków
	// district/city suffix ("ul. Magnoliowa" is in Wieliczka, not Kraków):
	// the geocoder filters street matches by city, so the wrong city pins
	// nothing.
	const city = town ?? "Kraków";
	const area = town ? null : district;
	const mined = mineForumAddress(title);
	let address = mined
		? formatAddressForGeocode(mined.street, mined.number, area, city)
		: null;
	if (!address) {
		const nameGuess = investmentNameFallback(title);
		// Name that already contains the town ("Enklava Skawina") pins
		// through the validated bare-town shape ("Skawina, Kraków"); a
		// name that does not ("Pod Jabłoniami" + "Tarnów") gets the town
		// as its city instead of the Kraków default.
		const nameMentionsTown =
			town != null &&
			foldForCompare(nameGuess ?? "").includes(foldForCompare(town));
		if (town && nameGuess && !nameMentionsTown)
			address = formatAddressForGeocode(nameGuess, undefined, null, town);
		else if (town) address = formatAddressForGeocode(town, undefined, district);
		else if (nameGuess)
			address = formatAddressForGeocode(nameGuess, undefined, district);
	}
	if (!address) {
		const street = mineStreetWindow(title);
		if (street)
			address = formatAddressForGeocode(street, undefined, area, city);
	}
	address = sanitizeAddressHead(address);

	const features: Record<string, unknown> = {};
	if (author) features.author = author;
	if (replies != null) features.replies = replies;
	if (views != null) features.views = views;
	if (lastPostAt) features.lastPostAt = lastPostAt;

	// Thread-page enrichment (OP-mined address, the investment
	// description, the parsed posts) rides along on every re-crawl so
	// list-page rows never regress it.
	const cachedTopic = loadTopicCache()[topicId];
	let description: string | null = null;
	if (cachedTopic) {
		if (cachedTopic.address) address = cachedTopic.address;
		description = cachedTopic.description;
		if (cachedTopic.posts.length > 0) features.posts = cachedTopic.posts;
	}

	return {
		source: "budujesie",
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
		description,
		heatingType: null,
		propertyType: "inwestycja",
		features:
			Object.keys(features).length > 0 ? JSON.stringify(features) : null,
		lat: null,
		lng: null,
		listedAt,
		scrapedAt: new Date().toISOString(),
	};
}

/** prosilver thread posts: `<div class="post" id="p123">` blocks with the
 * author in the profile aside and the body in `.content`. */
export function parseThreadPosts($: CheerioSelection): ThreadPost[] {
	const posts: ThreadPost[] = [];
	$("div.post").each((_, el) => {
		const $post = $(el as never);
		if (!/^p\d+/u.test($post.attr("id") ?? "")) return;
		const author =
			$post.find("dl.postprofile dt a").eq(0).text().trim() ||
			$post.find("p.author strong a").eq(0).text().trim() ||
			null;
		const rawAt = $post.find("time[datetime]").eq(0).attr("datetime");
		// phpBB writes `+0200`; normalize to ISO `+02:00`.
		const at = rawAt ? rawAt.replace(/([+-]\d{2}):?(\d{2})$/, "$1:$2") : null;
		const text = $post
			.find("div.postbody div.content")
			.eq(0)
			.text()
			.replace(/\s+/g, " ")
			.trim();
		if (text) posts.push({ author, at, text: text.slice(0, 600) });
	});
	return posts;
}

/** Town mention in post prose ("w Wieliczce", "Wieliczka k. Krakowa"):
 * inflected forms match by last-word stem ("Wieliczka" -> "wielic"), at
 * word starts only ("zwłaszcza" must not match "Szczawnica"). Kraków is
 * excluded — every post mentions it and it is the default. */
export function mineTownInText(text: string): string | null {
	const fold = foldForCompare(text);
	for (const town of MAŁOPOLSKA_TOWNS) {
		if (town === "Kraków") continue;
		const stem = foldForCompare(town.split(" ").pop() ?? town).slice(0, 5);
		if (stem.length >= 4 && new RegExp(`\\b${stem}`, "u").test(fold))
			return town;
	}
	return null;
}

/** A junk head is worse than no address: it pollutes the row and can pin
 * to an unrelated street. Strip trailing prepositions ("Nad Stawem w"),
 * build-state verbs ("Dobrego Pasterza powstała") and noun debris
 * ("domków i segmentów", "z czego 2"); drop sub-3-char fragments
 * ("Apartamenty Go", "Osiedle Fi"). */
function sanitizeAddressHead(address: string | null): string | null {
	if (!address) return null;
	const parts = address.split(",");
	const head = (parts[0] ?? "")
		.replace(
			/\s+(?:w|z|i|na|przy|do|od|u|oraz|we|ze|powstała|powstały|powstaje|powstanie|zlokalizowana|znajduje)$/iu,
			"",
		)
		.trim();
	if (head.length < 3) return null;
	if (
		/^(?:domków|segmentów|mieszkań|lokali|budynków|etap\w*|czego|tych|tym|tego|wszystkich|każdego|nowych|nowe)\b/iu.test(
			head,
		)
	)
		return null;
	parts[0] = head;
	return parts.join(",");
}

/** Street candidates that are really prose fragments ("z czego 2"). */
const PROSE_HEAD_RE =
	/^(?:z|w|we|na|do|i|o|od|u|za|po|co|jak|że|by|się|oraz|ale|nie|tak|tu|jest|są|które|który|czego)\b/iu;

/** The OP usually states the real location in prose — far more reliable
 * than title mining. `townOverride` (the title's town) wins over a town
 * guessed from the post. */
export function minePostAddress(
	text: string,
	townOverride?: string,
): string | null {
	const parsed = parseAddressFromText(text);
	if (!parsed) return null;
	if (PROSE_HEAD_RE.test(parsed.street.trim())) return null;
	return sanitizeAddressHead(
		formatAddressForGeocode(
			resolveStreetName(parsed.street),
			parsed.number,
			null,
			townOverride ?? mineTownInText(text) ?? undefined,
		),
	);
}

/** Address for a thread row: the OP prose wins when it names a place that
 * agrees with the title's town (or when the title names none). A post
 * mentioning an unrelated place (a sales office in another town) never
 * displaces the title's location. */
export function chooseThreadAddress(
	title: string,
	cardAddress: string | null,
	opText: string | null,
): string | null {
	if (!opText) return cardAddress;
	const titleTown = mineTownName(title);
	const opTown = mineTownInText(opText);
	const townsAgree =
		!titleTown ||
		!opTown ||
		foldForCompare(titleTown) === foldForCompare(opTown);
	if (!townsAgree) return cardAddress;
	return (
		minePostAddress(opText, titleTown ?? opTown ?? undefined) ?? cardAddress
	);
}

const cardCache = new Map<string, Listing>();

export const budujesieAdapter: CheerioAdapter = {
	id: "budujesie",
	name: "BudujeSie.pl · inwestycje mieszkaniowe w budowie (Kraków)",
	kind: "cheerio",
	startUrls: [`${BASE}/${FORUM_PATH}`],
	// 52 list pages + one fetch per new/moved topic (all of them on the
	// first run, a handful per hour afterwards).
	maxRequestsPerCrawl: 1600,
	// Re-sync the whole list every run (komornik precedent).
	alwaysFullCrawl: true,
	// Kept on the object for the validator; the dispatcher runs
	// `extractHtml` instead when both are present.
	listingSelector: LIST_SELECTOR,
	nextPageSelector: NEXT_PAGE_SELECTOR,
	parseListingCard: parseTopicCard,

	// Strategy B rides along on top of the cards: thread pages carry the
	// OP (address + investment description) and the comments under it.
	// The dispatcher short-circuits to extractHtml, so list pages are
	// re-emitted here as cards.
	async extractHtml(_html, url, enqueue, root) {
		const $ = root;
		if (!$) return [];
		const topicId = new URL(url, BASE).searchParams.get("t");
		if (/viewtopic\.php/u.test(url) && topicId) {
			const card = cardCache.get(topicId);
			if (!card) return [];
			const posts = parseThreadPosts($).slice(0, 8);
			// A topic always has at least one post; zero means the markup
			// changed — keep the cache untouched so the next run retries.
			if (posts.length === 0) return [card];
			const opText = posts[0]?.text ?? null;
			const features = parseFeaturesJson(card.features);
			features.posts = posts;
			const merged: Listing = {
				...card,
				address: chooseThreadAddress(card.title, card.address, opText),
				description: opText ? opText.slice(0, 2000) : card.description,
				features: JSON.stringify(features),
			};
			const cache = loadTopicCache();
			cache[topicId] = {
				lastPostAt: (features.lastPostAt as string | undefined) ?? null,
				address: merged.address,
				description: merged.description,
				posts,
			};
			saveTopicCache(cache);
			return [merged];
		}

		// Forum list page.
		const cards: Listing[] = [];
		$(LIST_SELECTOR).each((_, el) => {
			const card = parseTopicCard($, el);
			if (card) cards.push(card);
		});
		const cache = loadTopicCache();
		const toFetch: string[] = [];
		for (const card of cards) {
			cardCache.set(card.externalId, card);
			const lastPostAt =
				(parseFeaturesJson(card.features).lastPostAt as string | undefined) ??
				null;
			const seen = cache[card.externalId];
			// Only topics whose thread moved since the last fetch.
			if (!seen || seen.lastPostAt !== lastPostAt) toFetch.push(card.url);
		}
		if (toFetch.length > 0) await enqueue(toFetch);
		const next = $(NEXT_PAGE_SELECTOR).attr("href");
		if (next) await enqueue([new URL(next, url).toString()]);
		return cards;
	},
};
