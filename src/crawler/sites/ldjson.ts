/**
 * Extract every `<script type="application/ld+json">` block from an HTML
 * page. Multiple real-estate portals embed their listing feed this way.
 */
export function parseLdJson(html: string): unknown[] {
	const blocks: unknown[] = [];
	const re =
		/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g;
	for (const m of html.matchAll(re)) {
		try {
			blocks.push(JSON.parse(m[1].trim()));
		} catch {
			// Skip malformed blocks; one bad block must not kill the page.
		}
	}
	return blocks;
}

/** Find a node anywhere in the parsed JSON (depth-first) matching a type. */
export function findLdNode(
	nodes: unknown[],
	pred: (n: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
	const visit = (n: unknown): Record<string, unknown> | null => {
		if (Array.isArray(n)) {
			for (const item of n) {
				const found = visit(item);
				if (found) return found;
			}
			return null;
		}
		if (n && typeof n === "object") {
			const rec = n as Record<string, unknown>;
			if (pred(rec)) return rec;
			for (const v of Object.values(rec)) {
				const found = visit(v);
				if (found) return found;
			}
		}
		return null;
	};
	for (const node of nodes) {
		const found = visit(node);
		if (found) return found;
	}
	return null;
}

/** Find all nodes matching a type anywhere in the parsed JSON. */
export function findLdNodes(
	nodes: unknown[],
	pred: (n: Record<string, unknown>) => boolean,
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	const visit = (n: unknown): void => {
		if (Array.isArray(n)) {
			for (const item of n) visit(item);
			return;
		}
		if (n && typeof n === "object") {
			const rec = n as Record<string, unknown>;
			if (pred(rec)) out.push(rec);
			for (const v of Object.values(rec)) visit(v);
		}
	};
	for (const node of nodes) visit(node);
	return out;
}
