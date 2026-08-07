import Database from "better-sqlite3";

const db = new Database("dev.db");
const n = (db.prepare(
	"SELECT count(*) n FROM listings WHERE lat IS NOT NULL",
).get() as { n: number }).n;
console.log("with coords now:", n);
const m = (db.prepare(
	'SELECT count(*) n FROM listings WHERE source = "morizon" AND lat IS NOT NULL',
).get() as { n: number }).n;
console.log("morizon with coords:", m);
