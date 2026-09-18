import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { autoMigrate } from "./migrate.ts";
import * as schema from "./schema.ts";

// drizzle-kit and the tsx scripts also rely on DATABASE_URL from .env.local.
// The vite/Nitro dev server runs this under Node (even when launched via
// `bun run dev`), so better-sqlite3 is the correct driver here.
config({ path: [".env.local", ".env"] });

/** Where the SQLite file lands when DATABASE_URL is unset (fresh clone). */
export const DEFAULT_DATABASE_PATH = "dev.db";

function resolveDatabasePath(): string {
	const configured = process.env.DATABASE_URL?.trim();
	// An empty assignment in `.env.local` (`DATABASE_URL=`) surfaces as "",
	// which must mean "unset", not "empty filename".
	const raw = configured ? configured : DEFAULT_DATABASE_PATH;
	return raw.replace(/^file:/, "");
}

export const databasePath = resolveDatabasePath();

// Nothing to prepare for an in-memory DB; a path with directories
// (data/dev.db) must exist before better-sqlite3 opens it.
if (databasePath !== ":memory:") {
	mkdirSync(dirname(resolve(databasePath)), { recursive: true });
}

export const sqlite = new Database(databasePath);

// Fresh clone bootstrap: create the schema from `drizzle/` migrations on
// first use, so `npm install && npm run dev` works with no DB and no
// `.env.local`. Re-runs are no-ops.
const migration = autoMigrate(sqlite);

if (!process.env.DATABASE_URL?.trim()) {
	console.log(
		`[db] DATABASE_URL not set; using ./${databasePath} (copy .env.local.example to .env.local to change it)`,
	);
}
if (migration.created) {
	console.log(
		`[db] created empty ${databasePath} and applied ${migration.applied} migration(s); the background crawl will populate it`,
	);
} else if (migration.applied > 0) {
	console.log(
		`[db] applied ${migration.applied} migration(s) to ${databasePath}`,
	);
}

export const db = drizzle(sqlite, { schema });
