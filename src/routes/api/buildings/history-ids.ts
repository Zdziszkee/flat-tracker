import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { db } from "#/db/index";
import { buildings, transactions } from "#/db/schema";

/**
 * OSM ids of buildings that have RCN transaction history, used by the map
 * to color the Mapbox composite building layer via feature-state (so the
 * coloring uses the real building height from Mapbox tiles).
 */

let cache: number[] | null = null;

async function getHistoryOsmIds(): Promise<number[]> {
	if (cache) return cache;

	const rows = await db
		.selectDistinct({ osmId: buildings.osmId })
		.from(buildings)
		.innerJoin(transactions, eq(transactions.buildingId, buildings.id));

	cache = rows.map((r) => r.osmId);
	return cache;
}

export const Route = createFileRoute("/api/buildings/history-ids")({
	server: {
		handlers: {
			GET: async () => {
				const osmIds = await getHistoryOsmIds();
				return json({ osmIds, count: osmIds.length });
			},
		},
	},
});
