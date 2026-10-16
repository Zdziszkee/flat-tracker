import { db } from "../src/db/index";
import { sql } from "drizzle-orm";

// Regression check: the migration chain applies to a fresh DB (the
// zero-setup promise — point DATABASE_URL at an empty path) and includes
// the current columns. Worker-generated migrations are the risk here:
//   DATABASE_URL=/tmp/fresh.db bunx tsx scripts/validate-migrate.ts
const cols = (
	db.all(sql`select name from pragma_table_info('listings')`) as {
		name: string;
	}[]
).map((r) => r.name);
console.log(
	"columns:",
	cols.length,
	"construction_end_label:",
	cols.includes("construction_end_label"),
	"construction_end_date:",
	cols.includes("construction_end_date"),
);
const j = db.all(sql`select count(*) as n from __drizzle_migrations`) as {
	n: number;
}[];
console.log("journal rows:", j[0].n);
if (
	!cols.includes("construction_end_label") ||
	!cols.includes("construction_end_date")
) {
	console.error("MIGRATION CHECK FAILED: timeline columns missing");
	process.exitCode = 1;
} else {
	console.log("ALL PASS");
}
