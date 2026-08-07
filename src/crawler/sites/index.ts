import type { SiteAdapter } from "../types.ts";
import { booksAdapter } from "./books.ts";
import { olxAdapter } from "./olx.ts";
import { otodomAdapter } from "./otodom.ts";
import { quotesAdapter } from "./quotes.ts";

/** All site adapters available to the crawler. */
export const adapters: SiteAdapter[] = [
	otodomAdapter,
	olxAdapter,
	quotesAdapter,
	booksAdapter,
];

/** Look up an adapter by its id. */
export function getAdapter(id: string): SiteAdapter {
	const adapter = adapters.find((a) => a.id === id);
	if (!adapter) {
		throw new Error(
			`Unknown site "${id}". Available: ${adapters.map((a) => a.id).join(", ")}`,
		);
	}
	return adapter;
}
