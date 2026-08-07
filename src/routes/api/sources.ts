import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { isNotNull } from "drizzle-orm";
import { db } from "#/db/index";
import { listings } from "#/db/schema";

/** Distinct listing sources that currently have map coordinates. */
export const Route = createFileRoute("/api/sources")({
	server: {
		handlers: {
			GET: async () => {
				const rows = await db
					.selectDistinct({ source: listings.source })
					.from(listings)
					.where(isNotNull(listings.lat))
					.orderBy(listings.source);
				return json({ sources: rows.map((r) => r.source) });
			},
		},
	},
});
