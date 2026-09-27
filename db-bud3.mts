import { db } from "./src/db/index";
import { sql } from "drizzle-orm";
const rows = db.all(sql`SELECT url FROM listings WHERE source='budujesie' ORDER BY COALESCE(listed_at,0) DESC LIMIT 1`);
console.log(rows[0]?.url);
