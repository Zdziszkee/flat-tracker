import { gzip as gzipCallback } from "node:zlib";

/** Whether the client advertised gzip (browsers always do). */
export function acceptsGzip(request: Request): boolean {
	return /\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "");
}

/** Async gzip so a multi-megabyte body does not block the event loop. */
export function gzipJson(body: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		gzipCallback(body, (error, compressed) => {
			if (error) reject(error);
			else resolve(compressed);
		});
	});
}

/**
 * JSON response with optional precomputed gzip bytes. The map feed is ~35 MB
 * raw but ~3.9 MB gzipped, so it ships compressed and advertises `Vary` for
 * caches. Callers that already compressed the body pass `gzip` to avoid
 * paying for it on every request.
 */
export async function jsonResponse(
	body: string,
	request: Request,
	gzip?: Buffer,
): Promise<Response> {
	const headers = new Headers({
		"content-type": "application/json; charset=utf-8",
		vary: "Accept-Encoding",
	});
	if (acceptsGzip(request)) {
		const compressed = gzip ?? (await gzipJson(body));
		// `Buffer` is backed by `ArrayBufferLike`; Response wants a plain
		// `Uint8Array<ArrayBuffer>`, so copy into one.
		const bytes = new Uint8Array(compressed.byteLength);
		bytes.set(compressed);
		headers.set("content-encoding", "gzip");
		headers.set("content-length", String(compressed.byteLength));
		return new Response(bytes, { headers });
	}
	headers.set("content-length", String(Buffer.byteLength(body)));
	return new Response(body, { headers });
}
