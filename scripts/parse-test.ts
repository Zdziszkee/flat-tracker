import "dotenv/config";

import { parseGml } from "#/crawler/import-rcn";

const res = await parseGml(process.env.RCN_GML_PATH ?? "");
console.log("transactions:", res.transactions.size);
console.log("dokumenty:", res.dokumenty.size);
console.log("nieruchomosci:", res.nieruchomosci.size);
console.log("dzialki:", res.dzialki.size);
console.log("budynki:", res.budynki.size);
console.log("lokale:", res.lokale.size);
console.log("adresy:", res.adresy.size);

let withPos = 0;
let withDzPos = 0;
let withBudPos = 0;
for (const n of res.nieruchomosci.values()) {
  if (n.pos) withPos++;
}
for (const d of res.dzialki.values()) {
  if (d) withDzPos++;
}
for (const b of res.budynki.values()) {
  if (b) withBudPos++;
}
console.log("nieruchomosci with pos:", withPos);
console.log("dzialki with pos:", withDzPos);
console.log("budynki with pos:", withBudPos);

const first = [...res.nieruchomosci.values()].find((n) => n.pos);
console.log("sample pos:", JSON.stringify(first?.pos));

let lokWithPos = 0;
for (const l of res.lokale.values()) {
  if (l.pos) lokWithPos++;
}
console.log("lokale with pos:", lokWithPos);
const lokSample = [...res.lokale.values()].find((l) => l.pos);
console.log("lokal sample pos:", JSON.stringify(lokSample?.pos));
