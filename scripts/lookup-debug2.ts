import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.ts";
try {
  const meta = await db.get<{ land_use: string | null; area_ha: number | null }>(
    sql`SELECT land_use, zoning, area_ha FROM parcel_meta WHERE parcel_id = ${"120801_2.0015.275/1"}`,
  );
  console.log("meta ok:", meta);
} catch (e) {
  console.log("meta FAIL:", String(e).slice(0, 200));
}
process.exit(0);
