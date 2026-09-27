/**
 * Regression checks for the budujesie.pl forum adapter.
 *
 * `parseListingCard` is exercised against pinned HTML fixtures (the phpBB
 * date variants: "25 kwie 2025, 10:29" 4-letter April, "Dzisiaj/Wczoraj",
 * time-less old dates, "Załączniki autor:" attachment rows) and then
 * against 2 live forum pages for parse coverage. Run:
 *
 *   bunx tsx scripts/validate-budujesie.ts
 */
import * as cheerio from "cheerio";
import {
	budujesieAdapter,
	chooseThreadAddress,
	minePostAddress,
	mineTownInText,
	parseThreadPosts,
} from "../src/crawler/sites/budujesie";

// Fixtures must not read (or write) the live per-topic thread cache — the
// pinned rows use small topic ids that would collide with real entries.
process.env.BUDUJESIE_TOPIC_CACHE = `/tmp/budujesie-topics-fixtures-${process.pid}.json`;

let failures = 0;
const check = (ok: boolean, label: string, extra = ""): void => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
	if (!ok) failures++;
};

function parseRow(html: string) {
	const $ = cheerio.load(`<ul>${html}</ul>`);
	const el = $("li.row").first();
	return budujesieAdapter.parseListingCard?.($ as never, el.get(0) as never) ?? null;
}

/** "Dzisiaj/Wczoraj, HH:MM" resolves to this local wall-clock string. */
function wallClock(dayOffset: number, hours: number, minutes: number): string {
	const d = new Date();
	d.setDate(d.getDate() + dayOffset);
	d.setHours(hours, minutes, 0, 0);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hours)}:${pad(minutes)}:00`;
}

// --- pinned fixtures -------------------------------------------------------

const rows: Array<[string, string | null, string | null, string | null]> = [
	[
		// 4-letter "kwie" (kwiecień) used to be the only unparseable month
		// form in the whole forum: 91 April-started topics lost listedAt.
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=11930">Gardenia Kraków / Bryksy deweloper (ul. Na Błonie 2) - opinie na forum</a>
		 <div class="responsive-hide">autor: traker » 25 kwie 2025, 10:29</div>
		 <dd class="lastpost"><span>Ostatni post autor: x Wyświetl najnowszy post 01 wrz 2026, 13:48</span></dd>
		 <dd class="posts">5 Odpowiedzi</dd><dd class="views">1463 Odsłony</dd></li>`,
		"2025-04-25T10:29:00",
		"Błonie",
		"2026-09-01T13:48:00",
	],
	[
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=1">Test</a>
		 <div class="responsive-hide">Załączniki autor: Hakelbery » 20 kwie 2021, 14:57</div>
		 <dd class="lastpost">Ostatni post autor: Vistula Wyświetl najnowszy post 10 gru 2023, 9:27</dd></li>`,
		"2021-04-20T14:57:00",
		null,
		"2023-12-10T09:27:00",
	],
	[
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=2">Test</a>
		 <div class="responsive-hide">autor: Master » 25 wrz 2026, 12:44</div>
		 <dd class="lastpost">Ostatni post autor: x Wyświetl najnowszy post 19 maja 2024, 11:35</dd></li>`,
		"2026-09-25T12:44:00",
		null,
		"2024-05-19T11:35:00",
	],
	[
		// Old topics drop the time; single-digit hour in lastpost.
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=3">Test</a>
		 <div class="responsive-hide">autor: x » 19 maja 2024</div>
		 <dd class="lastpost">Ostatni post autor: x Wyświetl najnowszy post 24 sty 2025, 9:45</dd></li>`,
		"2024-05-19T00:00:00",
		null,
		"2025-01-24T09:45:00",
	],
	[
		// Relative dates resolve against today's wall clock.
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=4">Test</a>
		 <div class="responsive-hide">autor: x » Dzisiaj, 13:26</div>
		 <dd class="lastpost">Ostatni post autor: x Wyświetl najnowszy post Wczoraj, 15:03</dd></li>`,
		wallClock(0, 13, 26),
		null,
		wallClock(-1, 15, 3),
	],
	[
		// A town in the title overrides the default Kraków city — the street
		// "ul. Magnoliowa" is in Wieliczka and must not carry ", Kraków".
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=5">Inwestycja Magnoliowa - Wieliczka - opinie na forum</a>
		 <div class="responsive-hide">autor: x » 19 maja 2024</div>
		 <dd class="lastpost">Ostatni post autor: x Wyświetl najnowszy post 19 maja 2024, 11:35</dd></li>`,
		"2024-05-19T00:00:00",
		"Wieliczka!Kraków",
		"2024-05-19T11:35:00",
	],
	[
		// Town after a " - " commentary split still wins over the default city.
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=6">Inwestycja Pod Jabłoniami - Tarnów opinie i forum o nowych mieszkaniach</a>
		 <div class="responsive-hide">autor: x » 19 maja 2024</div>
		 <dd class="lastpost">Ostatni post autor: x Wyświetl najnowszy post 19 maja 2024, 11:35</dd></li>`,
		"2024-05-19T00:00:00",
		"Tarnów!Kraków",
		"2024-05-19T11:35:00",
	],
	[
		// A name that already contains the town keeps the bare-town shape the
		// geocoder's title-town override resolves ("Skawina, Kraków").
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=7">Enklava Skawina - nowe mieszkania od XYZ forum</a>
		 <div class="responsive-hide">autor: x » 19 maja 2024</div>
		 <dd class="lastpost">Ostatni post autor: x Wyświetl najnowszy post 19 maja 2024, 11:35</dd></li>`,
		"2024-05-19T00:00:00",
		"Skawina",
		"2024-05-19T11:35:00",
	],
	[
		// Town behind an opening paren still matches ("(Wieliczka / Kraków)").
		`<li class="row"><a class="topictitle" href="./viewtopic.php?f=5&amp;t=8">Aleja Zbożowa (Wieliczka / Kraków) - WBG Development forum</a>
		 <div class="responsive-hide">autor: x » 19 maja 2024</div>
		 <dd class="lastpost">Ostatni post autor: x Wyświetl najnowszy post 19 maja 2024, 11:35</dd></li>`,
		"2024-05-19T00:00:00",
		"Wieliczka!Kraków",
		"2024-05-19T11:35:00",
	],
];

for (const [html, wantListedAt, wantAddressPart, wantLastPost] of rows) {
	const listing = parseRow(html);
	check(
		listing?.listedAt === wantListedAt,
		`listedAt ${wantListedAt ?? "(none)"}`,
		`got ${listing?.listedAt}`,
	);
	if (wantAddressPart) {
		const [want, forbid] = wantAddressPart.split("!");
		check(
			(listing?.address ?? "").includes(want),
			`address contains ${want}`,
			`got ${listing?.address}`,
		);
		if (forbid) {
			check(
				!(listing?.address ?? "").includes(forbid),
				`address excludes ${forbid}`,
				`got ${listing?.address}`,
			);
		}
	}
	const lastPost = (listing?.features ? JSON.parse(listing.features) : {}).lastPostAt;
	check(
		lastPost === wantLastPost,
		`lastPostAt ${wantLastPost ?? "(none)"}`,
		`got ${lastPost ?? "(none)"}`,
	);
}

// --- thread pages: posts + OP address ------------------------------------

const threadHtml = `<div id="page-body">
  <div class="post has-profile" id="p101">
    <p class="author"><time datetime="2024-05-19T10:00:00+0200">19 maja 2024</time></p>
    <dl class="postprofile"><dt><a class="username">developer1</a></dt></dl>
    <div class="postbody"><div class="content">Inwestycja Magnoliowa powstaje przy ul. Magnoliowej 8 w Wieliczce, 15 km od Krakowa. Budowa rozpoczęta w 2024 roku.</div></div>
  </div>
  <div class="post has-profile" id="p102">
    <p class="author"><time datetime="2024-06-01T09:30:00+0200">1 cze 2024</time></p>
    <dl class="postprofile"><dt><a class="username">mieszkanka</a></dt></dl>
    <div class="postbody"><div class="content">Czy ktoś wie, kiedy planowane jest zakończenie budowy?</div></div>
  </div>
  <div class="post has-profile" id="p103">
    <p class="author"><time datetime="2024-06-02T18:05:00+0200">2 cze 2024</time></p>
    <dl class="postprofile"><dt><a class="username">developer1</a></dt></dl>
    <div class="postbody"><div class="content">Zakończenie planowane jest na IV kwartał 2025.</div></div>
  </div>
</div>`;

{
	const $ = cheerio.load(threadHtml);
	const posts = parseThreadPosts($ as never);
	check(posts.length === 3, "thread: 3 posts parsed", `got ${posts.length}`);
	check(
		posts[0]?.author === "developer1",
		"thread: OP author",
		`got ${posts[0]?.author}`,
	);
	check(
		posts[0]?.at === "2024-05-19T10:00:00+02:00",
		"thread: OP at normalized",
		`got ${posts[0]?.at}`,
	);
	check(
		(posts[0]?.text ?? "").includes("ul. Magnoliowej 8"),
		"thread: OP text",
		`got ${(posts[0]?.text ?? "").slice(0, 60)}`,
	);
	check(
		posts[1]?.author === "mieszkanka",
		"thread: comment author",
		`got ${posts[1]?.author}`,
	);

	const addr = posts[0] ? minePostAddress(posts[0].text) : null;
	check((addr ?? "").includes("Magnoliow"), "OP address: street", `got ${addr}`);
	check(
		(addr ?? "").includes("Wieliczka"),
		"OP address: town from prose",
		`got ${addr}`,
	);
	check(
		!(addr ?? "").includes("Kraków"),
		"OP address: no Kraków default",
		`got ${addr}`,
	);

	const town = mineTownInText(
		"Budowa przy ul. Kwiatowej 3 w Tarnowie, dobra komunikacja z Krakowem",
	);
	check(town === "Tarnów", "town prose: Tarnów", `got ${town}`);

	// Guards: prose fragments never become street names, build verbs get
	// stripped, and a post about an unrelated place never displaces the
	// title's town.
	check(
		minePostAddress("W ofercie mamy 12 mieszkań z czego 2 to kawalerki.") ==
			null,
		"OP guard: prose fragment rejected",
	);
	const verbStripped = minePostAddress(
		"W Krakowie przy ulicy Dobrego Pasterza powstała / powstaje nowa inwestycja.",
	);
	check(
		verbStripped === "Dobrego Pasterza, Kraków",
		"OP address: build verb stripped",
		`got ${verbStripped}`,
	);
	const kept = chooseThreadAddress(
		"Magnoliowa Polana 2, Wieliczka (ul. Magnoliowa) od Techniq",
		"Magnoliowa, Wieliczka",
		"Biuro sprzedaży mieści się przy ul. Ochota 3 w Proszowicach.",
	);
	check(
		kept === "Magnoliowa, Wieliczka",
		"OP town conflict: title address kept",
		`got ${kept}`,
	);
	const agreed = chooseThreadAddress(
		"Magnoliowa Polana 2, Wieliczka (ul. Magnoliowa) od Techniq",
		"Magnoliowa Polana, Wieliczka",
		"Inwestycja powstaje przy ul. Magnoliowej 8 w Wieliczce.",
	);
	check(
		(agreed ?? "").includes("Magnoliow"),
		"OP town agrees: OP street wins",
		`got ${agreed}`,
	);
}

// --- live coverage ---------------------------------------------------------

for (const pageUrl of [
	"https://budujesie.pl/viewforum.php?f=5",
	"https://budujesie.pl/viewforum.php?f=5&start=500",
]) {
	const res = await fetch(pageUrl, {
		headers: { "User-Agent": "flat-tracker/1.0 (research; contact via repo)" },
	});
	const $ = cheerio.load(await res.text());
	const listings = $("li.row")
		.toArray()
		.map((el) => budujesieAdapter.parseListingCard?.($ as never, el as never) ?? null)
		.filter((l) => l != null);
	const dated = listings.filter((l) => l.listedAt != null).length;
	check(
		dated === listings.length && listings.length >= 20,
		`all rows dated on ${pageUrl}`,
		`${dated}/${listings.length}`,
	);
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
