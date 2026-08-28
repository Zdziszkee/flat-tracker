import Database from "better-sqlite3";
const db = new Database("dev.db", { readonly: true });
const anchorLat = 50.43361, anchorLng = 19.97839;
const dLat = 1000 / 111_320;
const dLng = 1000 / (111_320 * Math.cos((anchorLat * Math.PI) / 180));
const cutoff5y = Math.floor(Date.now() / 1000) - 5 * 365 * 86400;
const ownGroup = "rolna";
const rows = db.prepare(`
  SELECT t.pricePerM2 * 100 AS perAr, t.parcel_id AS pid, m.land_use AS lu
  FROM transactions t
  JOIN parcel_meta m ON m.parcel_id = t.parcel_id
  WHERE t.pricePerM2 > 0
    AND t.parcel_id IS NOT NULL
    AND t.lat BETWEEN ? AND ?
    AND t.lng BETWEEN ? AND ?
    AND t.date >= ?
    AND (CASE m.land_use
        WHEN 'gruntyZabudowaneIZurbanizowane' THEN 'zabudowana'
        WHEN 'gruntyRolne' THEN 'rolna'
        WHEN 'gruntyLesne' THEN 'lesna'
        ELSE COALESCE(m.land_use, 'inne') END) = ?
  ORDER BY t.date DESC
`).all(anchorLat - dLat, anchorLat + dLat, anchorLng - dLng, anchorLng + dLng, cutoff5y, ownGroup);
console.log(JSON.stringify(rows, null, 1));
