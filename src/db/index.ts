import { Database } from "bun:sqlite";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "./schema.ts";

// drizzle-kit (db:generate/migrate) reads only the schema and runs under
// Node, but the app and crawler run under Bun, so use bun:sqlite here.
config({ path: [".env.local", ".env"] });

const sqlite = new Database(process.env.DATABASE_URL ?? "dev.db");
export const db = drizzle(sqlite, { schema });
