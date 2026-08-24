import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { krakowDistricts } from "#/data/krakow-districts";
import { db } from "#/db/index";
import { listings, transactions } from "#/db/schema";

/**
 * District choropleth data: per-Kraków-dzielnica metrics joined onto the
 * bundled OSM boundaries. Listing metrics come straight from the `district`
 * column; the RCN transacted price/m² is assigned to a dzielnica by
 * point-in-polygon over the transaction coordinates.
 */

interface DistrictPoly {
	name: string;
	ring: Array<[number, number]>; // [lon, lat]
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

const districtPolys: DistrictPoly[] = krakowDistricts.map((f) => {
	const ring = f.geometry.coordinates[0] as unknown as Array<[number, number]>;
	let minLon = Number.POSITIVE_INFINITY;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	for (const [lon, lat] of ring) {
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
	}
	return { name: f.properties.name, ring, minLon, minLat, maxLon, maxLat };
});

function pointInRing(
	lon: number,
	lat: number,
	ring: Array<[number, number]>,
): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		const intersect =
			yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

export const Route = createFileRoute("/api/district-map")({
	server: {
		handlers: {
			GET: async () => {
				const sales = await db
					.select({
						district: listings.district,
						count: sql<number>`count(*)`,
						avgM2: sql<number | null>`avg(${listings.pricePerM2})`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'sale' and ${listings.isActive} = 1 and ${listings.pricePerM2} is not null and ${listings.district} is not null`,
					)
					.groupBy(listings.district)
					.all();

				const rents = await db
					.select({
						district: listings.district,
						count: sql<number>`count(*)`,
						avgM2: sql<number | null>`avg(${listings.pricePerM2})`,
					})
					.from(listings)
					.where(
						sql`${listings.offerType} = 'long_term_rental' and ${listings.isActive} = 1 and ${listings.pricePerM2} is not null and ${listings.district} is not null`,
					)
					.groupBy(listings.district)
					.all();

				const saleMap = new Map(sales.map((r) => [r.district, r]));
				const rentMap = new Map(rents.map((r) => [r.district, r]));

				// RCN transacted price/m² per dzielnica via point-in-polygon.
				const txs = await db
					.select({
						lat: transactions.lat,
						lng: transactions.lng,
						pricePerM2: transactions.pricePerM2,
					})
					.from(transactions)
					.where(
						sql`${transactions.pricePerM2} is not null and ${transactions.lat} is not null and ${transactions.lng} is not null`,
					)
					.all();

				const rcn = new Map<string, { sum: number; n: number }>();
				for (const t of txs) {
					if (t.lat == null || t.lng == null) continue;
					for (const p of districtPolys) {
						if (
							t.lng < p.minLon ||
							t.lng > p.maxLon ||
							t.lat < p.minLat ||
							t.lat > p.maxLat
						)
							continue;
						if (pointInRing(t.lng, t.lat, p.ring)) {
							const e = rcn.get(p.name) ?? { sum: 0, n: 0 };
							e.sum += t.pricePerM2 ?? 0;
							e.n += 1;
							rcn.set(p.name, e);
							break;
						}
					}
				}

				const features = districtPolys.map((p) => {
					const sale = saleMap.get(p.name);
					const rent = rentMap.get(p.name);
					const tx = rcn.get(p.name);
					const saleAvgM2 = sale?.avgM2 ?? null;
					const rentAvgM2 = rent?.avgM2 ?? null;
					const yieldPct =
						saleAvgM2 != null && rentAvgM2 != null && saleAvgM2 > 0
							? Number((((rentAvgM2 * 12) / saleAvgM2) * 100).toFixed(1))
							: null;
					return {
						name: p.name,
						saleCount: sale?.count ?? 0,
						saleAvgM2: saleAvgM2 != null ? Number(saleAvgM2.toFixed(0)) : null,
						rentCount: rent?.count ?? 0,
						rentAvgM2: rentAvgM2 != null ? Number(rentAvgM2.toFixed(1)) : null,
						yieldPct,
						rcnCount: tx?.n ?? 0,
						rcnAvgM2:
							tx && tx.n > 0 ? Number((tx.sum / tx.n).toFixed(0)) : null,
					};
				});

				return json({ features });
			},
		},
	},
});
