import {
	buildStreetIndex,
	matchAddressString,
	normStreet,
} from "./src/crawler/address-index";

const idx = await buildStreetIndex();
const probes = [
	"Magnoliowa",
	"Kwitnących Wiśni",
	"Szwai",
	"Bochenka",
	"Reduta",
	"Buszka",
	"Młyńska",
	"Dobra Forma",
	"Hortus",
	"Murarska",
];
for (const a of probes) {
	const key = normStreet(a);
	const direct = idx.byStreet.get(key) ?? [];
	const cities = new Set(direct.map((b) => b.city ?? "?"));
	const m = matchAddressString(idx, a, "Kraków");
	console.log(
		a.padEnd(18),
		"| key:",
		key.padEnd(18),
		"| buildings:",
		String(direct.length).padStart(3),
		"| cities:",
		[...cities].slice(0, 4).join("/"),
		"| match:",
		m ? `${m.lat.toFixed(4)},${m.lng.toFixed(4)}` : "NULL",
	);
}
