import { config } from "dotenv";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.ts";

// drizzle-kit and the crawler CLI both rely on DATABASE_URL from .env.local.
// The vite/Nitro dev server runs this under Node (even when launched via
// `bun run dev`), so better-sqlite3 is the correct driver here.
config({ path: [".env.local", ".env"] });

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set (check .env.local)");

export const db = drizzle(url, { schema });
