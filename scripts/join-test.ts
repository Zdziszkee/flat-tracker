import Database from "better-sqlite3";
const db = new Database("dev.db", { readonly: true });
// subject
console.log(db.prepare("SELECT land_use FROM parcel_meta WHERE parcel_id = '120801_2.0015.275/1'").get());
// the outliers' meta
console.log(db.prepare("SELECT parcel_id, land_use, area_ha FROM parcel_meta WHERE parcel_id IN ('120801_2.0015.288/11', '120801_2.0015.288/40')").all());
// is there a transaction with NULL parcel_id at 165000 on 2024-03-08?
console.log(db.prepare("SELECT transactionId, parcel_id, price, areaM2 FROM transactions WHERE price = 165000 AND parcel_id IS NULL LIMIT 5").all());
// run the grouped query
const rows = db.prepare(`
  SELECT t.pricePerM2 * 100 AS perAr, t.parcel_id AS pid
  FROM transactions t
  JOIN parcel_meta m ON m.parcel_id = t.parcel_id
  WHERE t.pricePerM2 > 0
    AND t.parcel_id IS NOT NULL
    AND t.lat BETWEEN 50.4246 AND 50.4426
    AND t.lng BETWEEN 19.9682 AND 19.9886
    AND t.date >= 1754544000
    AND (CASE m.land_use WHEN 'gruntyZabudowaneIZurbanizowane' THEN 'zabudowana' WHEN 'gruntyRolne' THEN 'rolna' WHEN 'gruntyLesne' THEN 'lesna' ELSE COALESCE(m.land_use, 'inne') END) = 'rolna'
  ORDER BY t.date DESC
`).all();
console.log("grouped rows:", rows.length, JSON.stringify(rows.slice(0, 8)));
