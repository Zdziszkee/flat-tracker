import { readFileSync } from "node:fs";
const cache = JSON.parse(readFileSync("data/crawler/budujesie-topics.json", "utf8")) as Record<string, { lastPostAt: string | null }>;
const old = Object.entries(cache).filter(([, v]) => (v.lastPostAt ?? "") < "2016").slice(0, 3);
console.log(old.map(([k, v]) => `${k} ${v.lastPostAt}`).join("\n"));
