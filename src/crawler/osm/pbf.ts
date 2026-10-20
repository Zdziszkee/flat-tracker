import { createReadStream } from "node:fs";
import osmPbf, { type OsmItem } from "osm-pbf-parser";

/**
 * Stream one Geofabrik extract and visit every OSM item. `osm-pbf-parser`
 * emits batches of items rather than an async iterator; this wraps the
 * stream in a promise and keeps the batch flattening in one place.
 *
 * Used by the building index and the railway overlay generator, which both
 * walk the same two voivodeship extracts.
 */
export function forEachPbfItem(
	pbfPath: string,
	visit: (item: OsmItem) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const osm = osmPbf();
		osm.on("data", (items: OsmItem[]) => {
			for (const item of items) visit(item);
		});
		osm.on("end", resolve);
		osm.on("error", reject);
		createReadStream(pbfPath).pipe(osm);
	});
}
