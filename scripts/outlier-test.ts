import Database from "better-sqlite3";
const db = new Database("dev.db", { readonly: true });
// find the exact outlier rows from basedOn (17000 and 281569 per-ar = 170 and 2815.7 per-m2)
const rows = db.prepare(`
  SELECT t.transactionId, t.parcel_id, t.price, t.areaM2, t.pricePerM2,
         m.land_use, m.area_ha
  FROM transactions t
  LEFT JOIN parcel_meta m ON m.parcel_id = t.parcel_id
  WHERE (t.pricePerM2 BETWEEN 169 AND 171 OR t.pricePerM2 BETWEEN 2815 AND 2816)
    AND t.lat BETWEEN 50.42 AND 50.45
    AND t.lng BETWEEN 19.95 AND 20.00
`).all();
console.log(JSON.stringify(rows, null, 1));
