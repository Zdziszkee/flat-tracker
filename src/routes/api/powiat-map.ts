import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { malopolskaPowiats } from "#/data/malopolska-powiats";
import { db } from "#/db/index";
import { listings, transactions } from "#/db/schema";

/**
 * Voivodeship choropleth: per-powiat metrics joined onto the bundled OSM
 * admin_level=6 boundaries.
 *
 * Assignment is coordinate-first: every listing/transaction with lat/lng is
 * dropped into its powiat by point-in-polygon (bbox prefiltered). Listings
 * without coordinates but with a district string are matched to a powiat by
 * normalized name (covers "Kraków" and the powiat names portals put in the
 * district field); everything else stays unassigned rather than guessing.
 */

interface PowiatPoly {
	name: string;
	ring: Array<[number, number]>; // [lon, lat]
	minLon: number;
	minLat: number;
	maxLon: number;
	maxLat: number;
}

const polys: PowiatPoly[] = malopolskaPowiats.map((f) => {
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

function norm(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]/g, "");
}

/** district string -> powiat name (normalized exact/prefix match). */
const powiatByNorm = new Map<string, string>();
for (const p of polys) {
	powiatByNorm.set(norm(p.name), p.name);
}
const NAME_ALIASES: Record<string, string> = {
	krakow: "Kraków",
	tarnow: "Tarnów",
	nowysacz: "Nowy Sącz",
};
function powiatForDistrict(district: string | null): string | null {
	if (!district) return null;
	const key = norm(district);
	const alias = NAME_ALIASES[key];
	if (alias) return alias;
	const exact = powiatByNorm.get(key);
	if (exact) return exact;
	// Prefix match: "tarnowski" -> "tarnowski" powiat entries already exact;
	// handle adjectival forms like "krakowski"/"miechowski" (exact above) and
	// longer portal strings ("wielicki", "powiat wielicki").
	for (const [k, name] of powiatByNorm) {
		if (key.length >= 5 && (key.includes(k) || k.includes(key))) return name;
	}
	return null;
}

export const Route = createFileRoute("/api/powiat-map")({
	server: {
		handlers: {
			GET: async () => {
				const metrics = new Map<
					string,
					{
						saleSum: number;
						saleN: number;
						saleCount: number;
						rentSum: number;
						rentN: number;
						rentCount: number;
					}
				>();
				const bucket = (name: string) => {
					let m = metrics.get(name);
					if (!m) {
						m = {
							saleSum: 0,
							saleN: 0,
							saleCount: 0,
							rentSum: 0,
							rentN: 0,
							rentCount: 0,
						};
						metrics.set(name, m);
					}
					return m;
				};

				// --- coordinate-first listing assignment ---
				// Plots ("działka", area > 500 m²) are excluded from sale
				// price/m² averages: a 630 m² plot at 120k zł would drag a
				// powiat's average down to nonsense (118 zł/m²).
				const rows = await db
					.select({
						lat: listings.lat,
						lng: listings.lng,
						district: listings.district,
						offerType: listings.offerType,
						pricePerM2: listings.pricePerM2,
						areaM2: listings.areaM2,
						title: listings.title,
					})
					.from(listings)
					.where(sql`${listings.isActive} = 1`)
					.all();

				const isPlot = (r: { areaM2: number | null; title: string | null }) =>
					(r.areaM2 ?? 0) > 500 ||
					(r.title?.toLowerCase().includes("działka") ?? false);

				for (const r of rows) {
					let name: string | null = null;
					if (r.lat != null && r.lng != null) {
						for (const p of polys) {
							if (
								r.lng < p.minLon ||
								r.lng > p.maxLon ||
								r.lat < p.minLat ||
								r.lat > p.maxLat
							)
								continue;
							if (pointInRing(r.lng, r.lat, p.ring)) {
								name = p.name;
								break;
							}
						}
					}
					if (!name) name = powiatForDistrict(r.district);
					if (!name) continue;

					const m = bucket(name);
					if (r.offerType === "sale") {
						m.saleCount++;
						if (r.pricePerM2 != null && r.pricePerM2 > 0 && !isPlot(r)) {
							m.saleSum += r.pricePerM2;
							m.saleN++;
						}
					} else if (r.offerType === "long_term_rental") {
						m.rentCount++;
						if (r.pricePerM2 != null) {
							m.rentSum += r.pricePerM2;
							m.rentN++;
						}
					}
				}

				// --- RCN transacted price/m² per powiat (all have coords) ---
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
					for (const p of polys) {
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

				const features = polys.map((p) => {
					const m = metrics.get(p.name);
					const tx = rcn.get(p.name);
					const saleAvgM2 = m && m.saleN > 0 ? m.saleSum / m.saleN : null;
					const rentAvgM2 = m && m.rentN > 0 ? m.rentSum / m.rentN : null;
					const yieldPct =
						saleAvgM2 != null && rentAvgM2 != null && saleAvgM2 > 0
							? Number((((rentAvgM2 * 12) / saleAvgM2) * 100).toFixed(1))
							: null;
					return {
						name: p.name,
						saleCount: m?.saleCount ?? 0,
						saleAvgM2: saleAvgM2 != null ? Number(saleAvgM2.toFixed(0)) : null,
						rentCount: m?.rentCount ?? 0,
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
