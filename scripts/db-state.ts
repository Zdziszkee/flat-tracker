import "dotenv/config";

import Database from "better-sqlite3";

const db = new Database(process.env.DATABASE_URL ?? "dev.db");
const rows = db
	.prepare("SELECT name FROM sqlite_master WHERE type='table'")
	.all() as Array<{ name: string }>;
console.log("tables:", rows.map((r) => r.name).join(", "));
const count = (t: string): number =>
	(db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
console.log("buildings:", count("buildings"));
console.log("listings:", count("listings"));
console.log(
	"listings assigned:",
	count("listings") === 0
		? 0
		: (db
				.prepare("SELECT count(*) n FROM listings WHERE building_id IS NOT NULL")
				.get() as { n: number }).n,
);
console.log("transactions:", count("transactions"));
