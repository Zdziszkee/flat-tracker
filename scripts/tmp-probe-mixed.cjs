const D = require("/home/zdziszkee/flat-tracker/node_modules/better-sqlite3");
const db = new D("/home/zdziszkee/flat-tracker/dev.db", { readonly: true });
const cutoff = Math.floor(Date.now() / 1000) - 5 * 365 * 86400;

const txStmt = db.prepare(
	`select count(*) n from transactions
	  where kind = ? and pricePerM2 is not null and areaM2 between ? and ?
	    and date >= ? and lat between ? and ? and lng between ? and ?`,
);
const lsStmt = db.prepare(
	`select count(*) n from listings
	  where property_kind = ? and is_visible = 1 and pricePerM2 is not null
	    and areaM2 between ? and ? and id <> ?
	    and map_lat between ? and ? and map_lng between ? and ?`,
);

for (const kind of ["house", "plot"]) {
	const txKind = kind === "house" ? "building" : "parcel";
	const offers = db
		.prepare(
			`select id, areaM2, map_lat, map_lng from listings
			  where property_kind = ? and is_visible = 1
			    and map_lat is not null and areaM2 is not null and pricePerM2 is not null`,
		)
		.all(kind);
	const counts = [];
	for (const o of offers) {
		const dLat = 1000 / 111320;
		const dLng = 1000 / (111320 * Math.cos((o.map_lat * Math.PI) / 180));
		const lo = o.areaM2 * 0.5;
		const hi = o.areaM2 * 2;
		const rcn = txStmt.get(
			txKind,
			lo,
			hi,
			cutoff,
			o.map_lat - dLat,
			o.map_lat + dLat,
			o.map_lng - dLng,
			o.map_lng + dLng,
		).n;
		const ls = lsStmt.get(
			kind,
			o.areaM2 * 0.25,
			o.areaM2 * 4,
			o.id,
			o.map_lat - dLat,
			o.map_lat + dLat,
			o.map_lng - dLng,
			o.map_lng + dLng,
		).n;
		counts.push(rcn + ls);
	}
	counts.sort((a, b) => a - b);
	const q = (p) => counts[Math.floor(p * (counts.length - 1))] ?? 0;
	const atLeast3 = counts.filter((c) => c >= 3).length;
	console.log(
		kind,
		"offers",
		counts.length,
		"median",
		q(0.5),
		"p25",
		q(0.25),
		"p75",
		q(0.75),
		"max",
		counts[counts.length - 1],
		">=3:",
		atLeast3,
		`(${Math.round((100 * atLeast3) / Math.max(1, counts.length))}%)`,
	);
}
db.close();
