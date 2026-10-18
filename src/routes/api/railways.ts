import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";

/**
 * GeoJSON of railways and stations for the tracked regions (Małopolska +
 * Śląsk), from the generated `src/data/region-railways.ts`
 * (`bun run build:railways`, Geofabrik extracts). The map draws it as the
 * "Kolej" overlay: lines and stations in one FeatureCollection so a single
 * URL-based GeoJSON source can serve both (layers split by geometry type;
 * the mapbox worker fetches and parses the payload off the UI thread).
 *
 * Lazy import on purpose: a missing generated file degrades this one
 * endpoint instead of taking the route tree down (see the .gitignore trap
 * in AGENTS.md).
 */

export const Route = createFileRoute("/api/railways")({
	server: {
		handlers: {
			GET: async () => {
				const mod = await import("#/data/region-railways");
				const features: Array<
					| {
							type: "Feature";
							geometry: {
								type: "LineString";
								coordinates: Array<[number, number]>;
							};
							properties: { kind: "line" };
					  }
					| {
							type: "Feature";
							geometry: { type: "Point"; coordinates: [number, number] };
							properties: { kind: "station"; name: string | null };
					  }
				> = [];
				for (const line of mod.RAIL_LINES) {
					features.push({
						type: "Feature",
						geometry: { type: "LineString", coordinates: line },
						properties: { kind: "line" },
					});
				}
				for (const s of mod.RAIL_STATIONS) {
					features.push({
						type: "Feature",
						geometry: { type: "Point", coordinates: s.pt },
						properties: { kind: "station", name: s.name },
					});
				}
				return json({ type: "FeatureCollection", features });
			},
		},
	},
});
