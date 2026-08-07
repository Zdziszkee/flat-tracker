import "dotenv/config";

import Database from "better-sqlite3";

const db = new Database(process.env.DATABASE_URL ?? "dev.db");
const count = (t: string): number =>
	(db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
console.log("buildings:", count("buildings"));
console.log("listings:", count("listings"));
console.log(
	"listings assigned:",
	(db.prepare(
		"SELECT count(*) n FROM listings WHERE building_id IS NOT NULL",
	).get() as { n: number }).n,
);
console.log("transactions:", count("transactions"));
console.log(
	"tx assigned:",
	(db.prepare(
		"SELECT count(*) n FROM transactions WHERE building_id IS NOT NULL",
	).get() as { n: number }).n,
);
