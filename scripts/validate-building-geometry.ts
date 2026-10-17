import "dotenv/config";

/**
 * Regression check for the map's building-footprint pipeline
 * (/api/buildings/geojson after simplifyRing + coordinate rounding):
 * every ring must stay closed, finite and inside Poland, and keep enough
 * vertices to extrude. Run against the dev server:
 *   bunx tsx scripts/validate-building-geometry.ts
 */

const BASE = process.env.MAP_BASE_URL ?? "http://localhost:3000";

interface Feature {
	id?: number;
	geometry: { type: string; coordinates: number[][][] };
	properties: { height?: number };
}

const res = await fetch(`${BASE}/api/buildings/geojson`);
if (!res.ok) {
	console.error(`GEOMETRY CHECK FAILED: HTTP ${res.status}`);
	process.exit(1);
}
const body = (await res.json()) as { features: Feature[] };
const problems: string[] = [];
let totalPts = 0;
let totalRings = 0;

for (const f of body.features) {
	const label = `feature ${f.id ?? "?"}`;
	if (f.geometry.type !== "Polygon") {
		problems.push(`${label}: geometry ${f.geometry.type}`);
		continue;
	}
	if (typeof f.properties.height !== "number" || !(f.properties.height > 0)) {
		problems.push(`${label}: bad height ${f.properties.height}`);
	}
	for (const ring of f.geometry.coordinates) {
		totalRings++;
		totalPts += ring.length;
		if (ring.length < 4) {
			problems.push(`${label}: ring with ${ring.length} points`);
			continue;
		}
		const [fx, fy] = ring[0];
		const [lx, ly] = ring[ring.length - 1];
		if (fx !== lx || fy !== ly) {
			problems.push(`${label}: ring not closed (${fx},${fy} vs ${lx},${ly})`);
		}
		for (const [x, y] of ring) {
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				problems.push(`${label}: non-finite coordinate`);
				break;
			}
			// Poland, roughly (the data is małopolska but validate broadly).
			if (x < 14 || x > 25 || y < 49 || y > 55) {
				problems.push(`${label}: out of bounds ${x},${y}`);
				break;
			}
		}
	}
}

console.log(
	`features: ${body.features.length}, rings: ${totalRings}, ` +
		`avg vertices/ring: ${(totalPts / Math.max(1, totalRings)).toFixed(1)}`,
);
if (problems.length > 0) {
	console.error(`${problems.length} PROBLEMS`);
	for (const p of problems.slice(0, 10)) console.error(`  ${p}`);
	process.exit(1);
}
console.log("ALL PASS");
