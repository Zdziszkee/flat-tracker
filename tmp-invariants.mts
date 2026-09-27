import Database from "better-sqlite3";

const db = new Database("dev.db", { readonly: true });
const rows = db
	.prepare(
		`SELECT id, externalId, url, title, address, listed_at, features, lat, lng
     FROM listings WHERE source = 'budujesie'`,
	)
	.all() as Array<{
	id: number;
	externalId: string;
	url: string;
	title: string;
	address: string | null;
	listed_at: number | null;
	features: string | null;
	lat: number | null;
	lng: number | null;
}>;
db.close();

let badJson = 0;
let badUrl = 0;
let dateOrder = 0;
let emptyTitle = 0;
const unlocated = new Map<string, number>();

for (const r of rows) {
	let f: Record<string, unknown> = {};
	if (r.features) {
		try {
			f = JSON.parse(r.features);
		} catch {
			badJson++;
		}
	}
	const wantUrl = `https://budujesie.pl/viewtopic.php?f=5&t=${r.externalId}`;
	if (r.url !== wantUrl) badUrl++;
	if (
		r.listed_at != null &&
		typeof f.lastPostAt === "string" &&
		r.listed_at > Date.parse(`${f.lastPostAt}Z`) / 1000 + 86400
	)
		dateOrder++;
	if (!r.title.trim()) emptyTitle++;
	if (r.lat == null && r.address) {
		unlocated.set(r.address, (unlocated.get(r.address) ?? 0) + 1);
	}
}

console.log(`rows: ${rows.length}`);
console.log(
	`invariants: badJson=${badJson} badUrl=${badUrl} listedAfterLastPost=${dateOrder} emptyTitle=${emptyTitle}`,
);
console.log(`\nun-geocoded with address: ${[...unlocated.values()].reduce((a, b) => a + b, 0)} rows, ${unlocated.size} distinct addresses`);
const sorted = [...unlocated.entries()].sort((a, b) => b[1] - a[1]);
for (const [addr, n] of sorted.slice(0, 40)) console.log(`${n}x  ${addr}`);
