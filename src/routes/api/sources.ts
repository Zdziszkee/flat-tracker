import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

import { db } from "#/db/index";
import { listings } from "#/db/schema";

/** Distinct listing sources that currently have any offers. */
export const Route = createFileRoute("/api/sources")({
	server: {
		handlers: {
			GET: async () => {
				const rows = await db
					.selectDistinct({ source: listings.source })
					.from(listings)
					.orderBy(listings.source);
				return json({ sources: rows.map((r) => r.source) });
			},
		},
	},
});
