/**
 * Regression guard for the Tailwind scan trap.
 *
 * `@tailwindcss/vite` scans the Vite root with the oxide Scanner, honouring
 * the negations compiled from `@source not` in `src/styles.css`. A generated
 * dataset written as one multi-MB line under `src/data/` (region-railways.ts,
 * region-uniqueness.ts) makes the scanner never return, which hangs the first
 * styles.css request and every request behind it.
 *
 * This script reproduces that exact configuration and puts a synthetic
 * trap file under `src/data/` before scanning:
 * - the scan must finish inside SCAN_TIMEOUT_MS,
 * - the trap (and every other `src/data/` file) must not be scanned,
 * - real source files must still be scanned.
 *
 * The scan runs in a child process because a hung native scan blocks the
 * event loop, so only a process kill can break out of it.
 *
 *   bun run validate:tailwind-scan
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "@tailwindcss/node";

const SCAN_TIMEOUT_MS = 20_000;
const ROOT = resolve(process.cwd());
const STYLES = resolve(ROOT, "src/styles.css");
const TRAP_BYTES = 3_000_000;

interface SourceEntry {
	base: string;
	pattern: string;
	negated: boolean;
}

interface ScanResult {
	candidates: string[];
	files: string[];
}

function fail(message: string): never {
	throw new Error(message);
}

/** The source globs @tailwindcss/vite feeds the scanner for this stylesheet. */
async function scannerSources(): Promise<SourceEntry[]> {
	const css = readFileSync(STYLES, "utf8");
	const compiler = await compile(css, {
		base: resolve(ROOT, "src"),
		from: STYLES,
		onDependency() {},
	});
	const rootSources: SourceEntry[] =
		compiler.root === "none"
			? []
			: compiler.root === null
				? [{ base: ROOT, pattern: "**/*", negated: false }]
				: [{ ...compiler.root, negated: false }];
	return [...rootSources, ...compiler.sources];
}

function relativeToRoot(file: string): string {
	return file.startsWith(`${ROOT}/`) ? file.slice(ROOT.length + 1) : file;
}

/**
 * Child mode: run the native scan and print its result as JSON. Kept in the
 * same file so the validator has no second entry point to keep in sync.
 */
async function scanChild(sourcesJson: string): Promise<void> {
	// Imported lazily: the parent only needs the compiler.
	const { Scanner } = await import("@tailwindcss/oxide");
	const sources = JSON.parse(sourcesJson) as SourceEntry[];
	const scanner = new Scanner({ sources });
	const candidates = scanner.scan();
	const result: ScanResult = {
		candidates,
		files: scanner.scannedFiles.map(relativeToRoot),
	};
	// No process.exit here: it can truncate a piped stdout write. Letting the
	// top-level await resolve flushes the pipe first.
	process.stdout.write(JSON.stringify(result));
}

async function main(): Promise<void> {
	const scanIndex = process.argv.indexOf("--scan");
	if (scanIndex !== -1) {
		await scanChild(process.argv[scanIndex + 1] ?? "[]");
		return;
	}

	const trapName = `__scan-trap-${process.pid}.ts`;
	const trapPath = resolve(ROOT, "src/data", trapName);
	// One line, well past the size that made the scanner spin on the real
	// generated datasets.
	const trap = `export const TRAP = "${"x".repeat(TRAP_BYTES)}";\n`;

	try {
		writeFileSync(trapPath, trap);
		const sources = await scannerSources();
		const child = spawnSync(
			process.execPath,
			[fileURLToPath(import.meta.url), "--scan", JSON.stringify(sources)],
			{
				cwd: ROOT,
				encoding: "utf8",
				timeout: SCAN_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 64 * 1024 * 1024,
			},
		);

		if (child.error) {
			fail(
				`scan did not finish in ${SCAN_TIMEOUT_MS} ms (${child.error.message}); ` +
					"is the `@source not './data/**'` rule still in src/styles.css?",
			);
		}
		if (child.status !== 0) {
			fail(`scan child exited ${child.status}: ${child.stderr.slice(0, 500)}`);
		}

		let result: ScanResult;
		try {
			result = JSON.parse(child.stdout) as ScanResult;
		} catch {
			fail(`scan child produced invalid JSON: ${child.stdout.slice(0, 300)}`);
		}

		const dataScanned = result.files.filter((file) =>
			file.replaceAll("\\", "/").startsWith("src/data/"),
		);
		if (dataScanned.length > 0) {
			fail(
				`scanned ${dataScanned.length} generated data file(s), e.g. ${dataScanned[0]}; ` +
					"add/exclude the dataset in src/styles.css",
			);
		}
		if (!result.files.some((file) => file.endsWith("src/routes/index.tsx"))) {
			fail("scan did not visit src/routes/index.tsx; the root source is missing");
		}
		if (result.candidates.length < 1_000) {
			fail(
				`scan found only ${result.candidates.length} candidates; expected the UI sources to be scanned`,
			);
		}

		console.log(
			`validate-tailwind-scan: ok — ${result.files.length} files scanned ` +
				`(${result.candidates.length} candidates), no src/data/ file read, ` +
				`trap ${TRAP_BYTES.toLocaleString("en-US")}-byte line excluded`,
		);
	} finally {
		rmSync(trapPath, { force: true });
	}
}

try {
	await main();
} catch (err) {
	console.error(
		`validate-tailwind-scan: ${err instanceof Error ? err.message : String(err)}`,
	);
	process.exitCode = 1;
}
