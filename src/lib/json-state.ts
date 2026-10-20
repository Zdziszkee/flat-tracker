import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Read a JSON state file, returning `null` when it is missing or malformed. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

export async function writeJsonFile(
	path: string,
	value: unknown,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2));
}
