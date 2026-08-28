import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { db } from "#/db/index";

/**
 * Per-offer valuation + net-ROI analysis.
 *
 * Compares an offer against three comp sets (price per m², sale offers):
 *   1. same BUILDING (listings.buildingId)
 *   2. same AREA (district, fallback 1 km bbox on coordinates)
 *   3. RCN TRANSACTIONS within ~1 km in the last 24 months (ground truth)
 * and blends them (building 50 %, area 25 %, RCN 25 % — renormalized over
 * whichever sets exist) into a fair-value estimate.
 *
 * Rental potential for the same flat:
 *   - LT (long-term): comparable LT rents in the area minus czynsz adm.
 *     (opłaty from the utilities JSON), ×12 × 92 % occupancy.
 *   - STR (Airbnb/Booking): comparable nightly rates within 1 km ×
 *     classified occupancy (blocked nights excluded) × 30.4 nights.
 * Net ROI = annual net income / asking price.
 */

const EPOCH_CUTOFF = Math.floor(Date.now() / 1000) - 365 * 2 * 86400;

function bbox(lat: number, lng: number, meters: number) {
	const dLat = meters / 111_320;
	const dLng = meters / (111_320 * Math.cos((lat * Math.PI) / 180));
	return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

function rating(pct: number): { label: string; tone: string } {
	if (pct <= -15) return { label: " mocno niedowartościowana", tone: "text-emerald-600" };
	if (pct <= -5) return { label: "niedowartościowana", tone: "text-emerald-600" };
	if (pct < 5) return { label: "wycena uczciwa", tone: "text-gray-700" };
	if (pct < 15) return { label: "lekko przewartościowana", tone: "text-amber-600" };
	return { label: "przewartościowana", tone: "text-red-600" };
}

function czynszFromUtilities(json: string | null): number {
	try {
		const u = JSON.parse(json ?? "{}") as { czynsz?: number | null };
		return typeof u.czynsz === "number" && u.czynsz > 0 ? u.czynsz : 0;
	} catch {
		return 0;
	}
}

export const Route = createFileRoute("/api/valuation/offer")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				const id = Number(new URL(request.url).searchParams.get("id"));
				if (!Number.isFinite(id)) {
					return json({ error: "id required" }, { status: 400 });
				}
				const offer = await db.get<{
					id: number;
					source: string;
					offerType: string;
					price: number | null;
					pricePerM2: number | null;
					areaM2: number | null;
					rooms: number | null;
					district: string | null;
					lat: number | null;
					lng: number | null;
					buildingId: number | null;
					utilities: string | null;
				}>(sql`
					SELECT id, source, offer_type AS offerType, price,
					       pricePerM2, areaM2, rooms, district,
					       lat, lng, building_id AS buildingId, utilities
					FROM listings WHERE id = ${id}
				`);
				if (!offer) return json({ error: "not found" }, { status: 404 });

				const offerM2 = offer.pricePerM2;

				// ---- 1. Same-building comp (sale offers) -------------------
				let building: { avg: number; n: number } | null = null;
				if (offer.buildingId != null && offerM2 != null) {
					const r = await db
						.get<{ avg: number; n: number }>(sql`
						SELECT avg(pricePerM2) AS avg, count(*) AS n
						FROM listings
						WHERE building_id = ${offer.buildingId}
						  AND id != ${offer.id}
						  AND offer_type = ${offer.offerType}
						  AND pricePerM2 IS NOT NULL
					`);
					if (r && r.n >= 2) building = r;
				}

				// ---- 2. Area comp (district, else 1 km bbox) ----------------
				let area: { avg: number; n: number } | null = null;
				if (offerM2 != null) {
					let r: { avg: number; n: number } | null = null;
					if (offer.district) {
						r = await db.get<{ avg: number; n: number }>(sql`
							SELECT avg(pricePerM2) AS avg, count(*) AS n
							FROM listings
							WHERE district = ${offer.district}
							  AND id != ${offer.id}
							  AND offer_type = ${offer.offerType}
							  AND pricePerM2 IS NOT NULL
						`);
					}
					if ((!r || r.n < 3) && offer.lat != null && offer.lng != null) {
						const b = bbox(offer.lat, offer.lng, 1000);
						r = await db.get<{ avg: number; n: number }>(sql`
							SELECT avg(pricePerM2) AS avg, count(*) AS n
							FROM listings
							WHERE id != ${offer.id}
							  AND offer_type = ${offer.offerType}
							  AND pricePerM2 IS NOT NULL
							  AND lat BETWEEN ${b.minLat} AND ${b.maxLat}
							  AND lng BETWEEN ${b.minLng} AND ${b.maxLng}
						`);
					}
					if (r && r.n >= 3) area = r;
				}

				// ---- 3. RCN transactions comp (1 km, 24 months) -------------
				let rcn: { avg: number; n: number } | null = null;
				if (offer.lat != null && offer.lng != null) {
					const b = bbox(offer.lat, offer.lng, 1000);
					const r = await db.get<{ avg: number; n: number }>(sql`
						SELECT avg(pricePerM2) AS avg, count(*) AS n
						FROM transactions
						WHERE pricePerM2 BETWEEN 500 AND 40000
						  AND lat BETWEEN ${b.minLat} AND ${b.maxLat}
						  AND lng BETWEEN ${b.minLng} AND ${b.maxLng}
						  AND date >= ${EPOCH_CUTOFF}
					`);
					if (r && r.n >= 3) rcn = r;
				}

				// ---- Blend (weights renormalize over available sets) --------
				const parts: Array<[number, number]> = [];
				if (building) parts.push([building.avg, 0.5]);
				if (area) parts.push([area.avg, 0.25]);
				if (rcn) parts.push([rcn.avg, 0.25]);
				const wSum = parts.reduce((a, [, w]) => a + w, 0);
				const fairM2 =
					wSum > 0 ? parts.reduce((a, [v, w]) => a + v * w, 0) / wSum : null;
				const overUnder =
					offerM2 != null && fairM2 != null && fairM2 > 0
						? (offerM2 / fairM2 - 1) * 100
						: null;

				// ---- 4. LT rental comps (net income) ------------------------
				let lt: {
					rentAvg: number;
					czynszAvg: number;
					n: number;
					netMonthly: number;
					netYearly: number;
					netYieldPct: number | null;
				} | null = null;
				if (offer.price != null && offer.lat != null && offer.lng != null) {
					const b = bbox(offer.lat, offer.lng, 1000);
					const r = await db.get<{
						rentAvg: number;
						czynszAvg: number;
						n: number;
					}>(sql`
						SELECT avg(price) AS rentAvg,
						       avg(coalesce(json_extract(utilities, '$.czynsz'), 0)) AS czynszAvg,
						       count(*) AS n
						FROM listings
						WHERE offer_type = 'long_term_rental'
						  AND price IS NOT NULL AND price > 0
						  AND lat BETWEEN ${b.minLat} AND ${b.maxLat}
						  AND lng BETWEEN ${b.minLng} AND ${b.maxLng}
					`);
					if (r && r.n >= 3) {
						const ownCzynsz = czynszFromUtilities(offer.utilities);
						const netMonthly = r.rentAvg - (ownCzynsz || r.czynszAvg);
						const netYearly = netMonthly * 12 * 0.92; // ~1 mies. vacancji
						lt = {
							rentAvg: Math.round(r.rentAvg),
							czynszAvg: Math.round(r.czynszAvg),
							n: r.n,
							netMonthly: Math.round(netMonthly),
							netYearly: Math.round(netYearly),
							netYieldPct:
								offer.price > 0 ? (netYearly / offer.price) * 100 : null,
						};
					}
				}

				// ---- 5. STR comps (net income, classified occupancy) --------
				let str: {
					nightlyAvg: number;
					occupancy: number;
					n: number;
					netMonthly: number;
					netYearly: number;
					netYieldPct: number | null;
				} | null = null;
				if (offer.price != null && offer.lat != null && offer.lng != null) {
					const b = bbox(offer.lat, offer.lng, 1000);
					const r = await db.get<{
						nightlyAvg: number;
						occ: number | null;
						n: number;
					}>(sql`
						SELECT avg(l.price) AS nightlyAvg,
						       avg(o.occupancy_rate) AS occ,
						       count(*) AS n
						FROM listings l
						LEFT JOIN listing_occupancy o
						  ON o.listing_id = l.id AND o.month = strftime('%Y-%m', 'now')
						WHERE l.source IN ('airbnb', 'booking')
						  AND l.price IS NOT NULL AND l.price > 0
						  AND l.lat BETWEEN ${b.minLat} AND ${b.maxLat}
						  AND l.lng BETWEEN ${b.minLng} AND ${b.maxLng}
					`);
					if (r && r.n >= 3 && r.nightlyAvg != null) {
						const occ = r.occ ?? null;
						const netMonthly =
							r.nightlyAvg * 30.4 * (occ != null ? occ : 0.55);
						const netYearly = netMonthly * 12;
						str = {
							nightlyAvg: Math.round(r.nightlyAvg),
							occupancy: occ != null ? occ : 0.55,
							n: r.n,
							netMonthly: Math.round(netMonthly),
							netYearly: Math.round(netYearly),
							netYieldPct:
								offer.price > 0 ? (netYearly / offer.price) * 100 : null,
						};
					}
				}

				return json({
					offer: {
						id: offer.id,
						price: offer.price,
						pricePerM2: offerM2,
						areaM2: offer.areaM2,
						offerType: offer.offerType,
					},
					comps: {
						building: building
							? { avgM2: Math.round(building.avg), n: building.n }
							: null,
						area: area ? { avgM2: Math.round(area.avg), n: area.n } : null,
						rcn: rcn ? { avgM2: Math.round(rcn.avg), n: rcn.n } : null,
						fairM2: fairM2 != null ? Math.round(fairM2) : null,
					},
					overUnderPct: overUnder != null ? Math.round(overUnder * 10) / 10 : null,
					rating: overUnder != null ? rating(overUnder) : null,
					lt,
					str,
				});
			},
		},
	},
});
