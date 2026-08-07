import 'dotenv/config'

import { findBuilding } from '#/crawler/geocode'

const points = [
  { lat: 50.034676, lng: 20.003542, label: 'Podgórze' },
  { lat: 50.06508, lng: 19.96237, label: 'Grzegórzki' },
  { lat: 50.08623, lng: 19.924982, label: 'Prądnik Biały' },
  { lat: 50.10957, lng: 19.90727, label: 'Tonie (otodom detail)' },
]

for (const p of points) {
  try {
    const b = await findBuilding(p.lat, p.lng)
    console.log(
      p.label,
      '->',
      b ? `OSM ${b.osmId} @ ${b.address ?? 'no address'}` : 'no building found',
    )
  } catch (err) {
    console.log(p.label, '-> ERROR', String(err).slice(0, 120))
  }
  await new Promise((r) => setTimeout(r, 500))
}
