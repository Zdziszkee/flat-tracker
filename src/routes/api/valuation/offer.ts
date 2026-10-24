import { createFileRoute } from "@tanstack/react-router";
import { json } from "@tanstack/react-start";
import { sql } from "drizzle-orm";

import { db } from "#/db/index";
import type { PropertyKind } from "#/lib/property-kind";
import { propertyKindOf } from "#/lib/property-kind";
import { estimateSaleValue } from "#/lib/valuation/offer-model";
import type { ValuationSegment } from "#/types/listing";

/**
 * Per-offer valuation + net-ROI analysis.
 */

function bbox(lat: number, lng: number, meters: number) {
	const dLat = meters / 111_320;
	const dLng = meters / (111_320 * Math.cos((lat * Math.PI) / 180));
	return {
		minLat: lat - dLat,
		maxLat: lat + dLat,
		minLng: lng - dLng,
		maxLng: lng + dLng,
	};
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
					externalId: string;
					title: string;
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
					propertyType: string | null;
					market: string | null;
					plotType: string | null;
				}>(sql`
					SELECT id, source, externalId, title, offer_type AS offerType, price,
					       pricePerM2, areaM2, rooms, district,
					       lat, lng, building_id AS buildingId, utilities,
					       property_type AS propertyType, market, plot_type AS plotType
					FROM listings WHERE id = ${id}
				`);
				if (!offer) return json({ error: "not found" }, { status: 404 });

				const kind = propertyKindOf({
					source: offer.source,
					title: offer.title,
					propertyType: offer.propertyType,
					externalId: offer.externalId,
				});
				const segment: ValuationSegment =
					kind === "house" ? "house" : kind === "plot" ? "plot" : "flat";

				const offerM2 = offer.pricePerM2;
				const ownArea = offer.areaM2 ?? null;

				// ---- 4/5. Rental comps with SIZE-matched bands --------------
				const hasGeo =
					offer.lat != null &&
					offer.lng != null &&
					offer.price != null &&
					offer.price > 0;
				const b = hasGeo
					? bbox(offer.lat as number, offer.lng as number, 1000)
					: null;

				const ltBasis = ownArea != null ? "podobny metraż" : "okolica";
				let lt: {
					rentAvg: number;
					czynszAvg: number;
					n: number;
					basis: string;
					netMonthly: number;
					netYearly: number;
					netYieldPct: number | null;
				} | null = null;
				let str: {
					nightlyAvg: number;
					occupancy: number;
					n: number;
					basis: string;
					netMonthly: number;
					netYearly: number;
					netYieldPct: number | null;
				} | null = null;
				if (b && hasGeo) {
					const tryLt = (band: "similar" | "wide" | "all") =>
						db.get<{ rentAvg: number; czynszAvg: number; n: number }>(sql`
						SELECT avg(price) AS rentAvg,
						       avg(coalesce(json_extract(utilities, '$.czynsz'), 0)) AS czynszAvg,
						       count(*) AS n
						FROM listings
						WHERE offer_type = 'long_term_rental'
						  AND price IS NOT NULL AND price > 0
						  AND lat BETWEEN ${b.minLat} AND ${b.maxLat}
						  AND lng BETWEEN ${b.minLng} AND ${b.maxLng}
						  ${
								ownArea != null && band === "similar"
									? sql`AND areaM2 BETWEEN ${ownArea * 0.6} AND ${ownArea * 1.4}`
									: sql``
							}
						  ${
								ownArea != null && band === "wide"
									? sql`AND areaM2 BETWEEN ${ownArea * 0.5} AND ${ownArea * 2}`
									: sql``
							}
					`);
					let picked: { n: number; basis: string } | null = null;
					let rentRow: {
						rentAvg: number;
						czynszAvg: number;
						n: number;
					} | null = null;
					for (const band of ["similar", "wide", "all"] as const) {
						const r = await tryLt(band);
						if (r && r.n >= 3) {
							rentRow = r;
							picked = {
								n: r.n,
								basis:
									ownArea == null
										? "okolica"
										: band === "similar"
											? `${ltBasis} (±40 % metrażu)`
											: band === "wide"
												? `${ltBasis} (±100 % metrażu)`
												: ltBasis,
							};
							break;
						}
					}
					if (rentRow && picked && offer.price != null && offer.price > 0) {
						const ownCzynsz = czynszFromUtilities(offer.utilities);
						const netMonthly =
							rentRow.rentAvg - (ownCzynsz || rentRow.czynszAvg);
						const netYearly = netMonthly * 12 * 0.92;
						lt = {
							rentAvg: Math.round(rentRow.rentAvg),
							czynszAvg: Math.round(rentRow.czynszAvg),
							n: rentRow.n,
							basis: picked.basis,
							netMonthly: Math.round(netMonthly),
							netYearly: Math.round(netYearly),
							netYieldPct: (netYearly / offer.price) * 100,
						};
					}

					const tryStr = (band: "similar" | "wide" | "all") =>
						db.get<{ nightlyAvg: number; occ: number | null; n: number }>(sql`
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
						  ${
								ownArea != null && band === "similar"
									? sql`AND l.areaM2 BETWEEN ${ownArea * 0.6} AND ${ownArea * 1.4}`
									: sql``
							}
						  ${
								ownArea != null && band === "wide"
									? sql`AND l.areaM2 BETWEEN ${ownArea * 0.5} AND ${ownArea * 2}`
									: sql``
							}
					`);
					let strPicked: { n: number; basis: string } | null = null;
					let strRow: {
						nightlyAvg: number;
						occ: number | null;
						n: number;
					} | null = null;
					for (const band of ["similar", "wide", "all"] as const) {
						const r = await tryStr(band);
						if (r && r.n >= 3 && r.nightlyAvg != null) {
							strRow = r;
							strPicked = {
								n: r.n,
								basis:
									ownArea == null
										? "okolica"
										: band === "similar"
											? `${ltBasis} (±40 % metrażu)`
											: band === "wide"
												? `${ltBasis} (±100 % metrażu)`
												: ltBasis,
							};
							break;
						}
					}
					if (strRow && strPicked && offer.price != null && offer.price > 0) {
						const occ = strRow.occ ?? null;
						const netMonthly =
							strRow.nightlyAvg * 30.4 * (occ != null ? occ : 0.55);
						const netYearly = netMonthly * 12;
						str = {
							nightlyAvg: Math.round(strRow.nightlyAvg),
							occupancy: occ != null ? occ : 0.55,
							n: strRow.n,
							basis: strPicked.basis,
							netMonthly: Math.round(netMonthly),
							netYearly: Math.round(netYearly),
							netYieldPct: (netYearly / offer.price) * 100,
						};
					}
				}

				// ---- Sale valuation via time-adjusted RCN comps -------------
				const isSale = offer.offerType === "sale";
				const saleResult =
					isSale && kind != null
						? await estimateSaleValue(
								{
									id: offer.id,
									source: offer.source,
									externalId: offer.externalId,
									title: offer.title,
									price: offer.price,
									pricePerM2: offer.pricePerM2,
									areaM2: offer.areaM2,
									rooms: offer.rooms,
									district: offer.district,
									lat: offer.lat,
									lng: offer.lng,
									buildingId: offer.buildingId,
									market: offer.market,
									plotType: offer.plotType,
									kind: segment,
								},
								new Date(),
							)
						: {
								estimate: null,
								reason: isSale ? "unsupported_kind" : "not_sale",
							};

				const mode = offer.offerType.includes("rent") ? "rent" : "sale";
				const eligible =
					saleResult.estimate != null || lt != null || str != null;

				return json({
					mode,
					eligible,
					reason: saleResult.estimate == null ? saleResult.reason : null,
					offer: {
						id: offer.id,
						price: offer.price,
						pricePerM2: offerM2,
						areaM2: offer.areaM2,
						offerType: offer.offerType,
						kind: kind as PropertyKind | null,
					},
					estimate: saleResult.estimate,
					rent: null,
					lt,
					str,
				});
			},
		},
	},
});
