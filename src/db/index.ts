import { config } from "dotenv";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.ts";

// drizzle-kit and the crawler CLI both rely on DATABASE_URL from .env.local
config({ path: [".env.local", ".env"] });

export const db = drizzle(process.env.DATABASE_URL!, { schema });
