declare module "osm-pbf-parser" {
	import type { Transform } from "node:stream";

	export interface OsmItem {
		type: "node" | "way" | "relation";
		id: number;
		lat?: number;
		lon?: number;
		refs?: number[];
		tags?: Record<string, string>;
	}

	interface OsmStream extends Transform {
		on(event: "data", listener: (items: OsmItem[]) => void): this;
		on(event: "end", listener: () => void): this;
		on(event: "error", listener: (err: Error) => void): this;
	}

	function osmPbfParser(): OsmStream;
	export default osmPbfParser;
}
