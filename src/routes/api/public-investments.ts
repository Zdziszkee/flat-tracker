import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { and, eq, gte, lte, type SQL } from "drizzle-orm";

import { db } from "#/db/index";
import { publicInvestments } from "#/db/schema";
import { categoryLabel, statusLabel } from "#/lib/public-investments";

/**
 * Planned/completed public investments as a GeoJSON FeatureCollection for
 * the map layer. Small dataset (hundreds of points), so no bbox is required;
 * optional `status`, `category` and `bbox=minLng,minLat,maxLng,maxLat`
 * filters keep the payload tight for focused views.
 */
export const Route = createFileRoute("/api/public-investments")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const url = new URL(request.url);
				const status = url.searchParams.get("status");
				const category = url.searchParams.get("category");
				const bbox = url.searchParams.get("bbox");
				const filters: SQL[] = [];
				if (status) filters.push(eq(publicInvestments.status, status));
				if (category) {
					filters.push(eq(publicInvestments.category, category));
				}
				if (bbox) {
					const [minLng, minLat, maxLng, maxLat] = bbox.split(",").map(Number);
					if (
						[minLng, minLat, maxLng, maxLat].every((value) =>
							Number.isFinite(value),
						)
					) {
						filters.push(
							gte(publicInvestments.lng, minLng),
							lte(publicInvestments.lng, maxLng),
							gte(publicInvestments.lat, minLat),
							lte(publicInvestments.lat, maxLat),
						);
					}
				}

				const rows = await db
					.select({
						id: publicInvestments.id,
						name: publicInvestments.name,
						category: publicInvestments.category,
						status: publicInvestments.status,
						description: publicInvestments.description,
						url: publicInvestments.url,
						lat: publicInvestments.lat,
						lng: publicInvestments.lng,
						year: publicInvestments.year,
						city: publicInvestments.city,
						region: publicInvestments.region,
					})
					.from(publicInvestments)
					.where(filters.length > 0 ? and(...filters) : undefined)
					.orderBy(publicInvestments.name);

				const features = rows
					.filter(
						(row): row is typeof row & { lat: number; lng: number } =>
							row.lat !== null && row.lng !== null,
					)
					.map((row) => ({
						type: "Feature" as const,
						geometry: {
							type: "Point" as const,
							coordinates: [row.lng, row.lat],
						},
						properties: {
							id: row.id,
							name: row.name,
							category: row.category,
							categoryLabel: categoryLabel(row.category),
							status: row.status,
							statusLabel: statusLabel(row.status),
							description: row.description,
							url: row.url,
							year: row.year,
							city: row.city,
							region: row.region,
						},
					}));

				return json(
					{ type: "FeatureCollection", features },
					{
						headers: {
							"Cache-Control": "public, max-age=300",
						},
					},
				);
			},
		},
	},
});
