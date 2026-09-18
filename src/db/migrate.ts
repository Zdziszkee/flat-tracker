import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.ts";

/**
 * Bootstrap migrations so a fresh clone works with zero setup: the first
 * process that opens the database creates it and applies every migration
 * in `drizzle/`. Re-runs are no-ops (drizzle's `__drizzle_migrations`
 * journal tracks what has been applied), so this is safe to call on every
 * boot, from the dev server and from the tsx scripts alike.
 */

/** Migration folder: repo-relative first (dev), module-relative as fallback. */
export function resolveMigrationsFolder(): string | null {
	const candidates = [
		resolve(process.cwd(), "drizzle"),
		fileURLToPath(new URL("../../drizzle", import.meta.url)),
	];
	for (const dir of candidates) {
		if (existsSync(resolve(dir, "meta", "_journal.json"))) return dir;
	}
	return null;
}

function tableNames(sqlite: Database.Database): string[] {
	const rows = sqlite
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		)
		.all() as Array<{ name: string }>;
	return rows.map((r) => r.name);
}

/** Rows in drizzle's migration journal (0 when the table does not exist). */
function appliedMigrations(sqlite: Database.Database): number {
	try {
		const row = sqlite
			.prepare("SELECT count(*) AS n FROM __drizzle_migrations")
			.get() as { n: number };
		return row.n;
	} catch {
		return 0;
	}
}

export interface MigrateResult {
	/** The DB file did not exist / had no tables before this call. */
	created: boolean;
	/** How many migrations were just applied. */
	applied: number;
}

/**
 * Apply pending migrations to `sqlite`.
 *
 * A database created outside migrations (e.g. `drizzle-kit push`) has
 * tables but no journal; running the migrator there would fail on the
 * first `CREATE TABLE`, so we skip it and say what to do instead.
 */
export function autoMigrate(sqlite: Database.Database): MigrateResult {
	const dir = resolveMigrationsFolder();
	if (!dir) {
		console.warn(
			"[db] no drizzle/ migration folder found; skipping auto-migrate (run `npm run db:migrate`)",
		);
		return { created: false, applied: 0 };
	}

	const tables = tableNames(sqlite);
	const created = tables.length === 0;
	const journaled = tables.includes("__drizzle_migrations");
	if (!created && !journaled) {
		console.warn(
			"[db] database has tables but no drizzle migration journal " +
				"(created by db:push?); skipping auto-migrate. " +
				"Use `npm run db:push` for schema changes, or delete the DB to rebuild from migrations.",
		);
		return { created, applied: 0 };
	}

	const before = appliedMigrations(sqlite);
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: dir });
	const applied = appliedMigrations(sqlite) - before;
	return { created, applied };
}
