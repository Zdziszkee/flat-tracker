import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Extract } from "unzipper";

/**
 * Download/extract plumbing shared by the Kraków GML importer and the GUGiK
 * per-powiat importer. The two parsers are deliberately separate (GML vs
 * GeoPackage), but the transport around them should not drift.
 */
export async function downloadToFile(
	url: string,
	path: string,
	timeoutMs?: number,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const res = await fetch(url, {
		signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
	});
	if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
	await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path));
}

export async function extractZip(
	zipPath: string,
	outDir: string,
): Promise<void> {
	await mkdir(outDir, { recursive: true });
	await new Promise<void>((resolve, reject) => {
		createReadStream(zipPath)
			.pipe(Extract({ path: outDir }))
			.on("close", resolve)
			.on("error", reject);
	});
}
