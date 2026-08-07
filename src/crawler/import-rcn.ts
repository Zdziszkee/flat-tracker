import "dotenv/config";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import proj4 from "proj4";
import { SaxesParser } from "saxes";
import { Extract } from "unzipper";
import { db } from "#/db/index";
import { transactions } from "#/db/schema";

/**
 * Imports the Krakow Rejestr Cen Nieruchomości (RCN) GML export.
 *
 * Source: https://rzeczoznawca.eco.um.krakow.pl/RCN/1261_RCN.zip
 * The zip contains RCN_4120101.gml (~2 GB), a GML file following the GUGiK
 * 2021 regulation. RCN data has been free since the law change of
 * 2026-02-13 ("declassified" transaction prices).
 *
 * The GML is streamed (never fully loaded) with `saxes`; features are
 * joined by gml:id references:
 *
 *   RCN_Transakcja --podstawaPrawna--> RCN_Dokument (transaction date)
 *   RCN_Transakcja --nieruchomosc-----> RCN_Nieruchomosc (geometry, lokal ref)
 *   RCN_Nieruchomosc --lokal----------> RCN_Lokal (area, rooms, floor, adres)
 *   RCN_Lokal --adresBudynkuZLokalem--> RCN_Adres (street, number)
 *
 * Only sales (rodzajTransakcji=1) of apartments (funkcjaLokalu=1,
 * mieszkalny) are imported. Rows are keyed by oznaczenieTransakcji, so
 * re-runs are idempotent.
 */

const RCN_ZIP_URL = "https://rzeczoznawca.eco.um.krakow.pl/RCN/1261_RCN.zip";
const DATA_DIR = "data/rcn";
const ZIP_PATH = `${DATA_DIR}/1261_RCN.zip`;
/** Override for testing with a partial file, e.g. RCN_GML_PATH=scripts/sample.gml */
const GML_PATH = process.env.RCN_GML_PATH ?? `${DATA_DIR}/RCN_4120101.gml`;

const BATCH_SIZE = 500;

/** Text fields we care about per feature type, minus the rcn: prefix. */
const TEXT_FIELDS = new Set([
	"oznaczenieTransakcji",
	"rodzajTransakcji",
	"rodzajRynku",
	"cenaTransakcjiBrutto",
	"dataSporzadzeniaDokumentu",
	"funkcjaLokalu",
	"nrKondygnacji",
	"powUzytkowaLokalu",
	"liczbaIzb",
	"ulica",
	"numerPorzadkowy",
]);

interface FeatureRec {
	type: string;
	id: string;
	fields: Record<string, string>;
	refs: Record<string, string>;
	pos: string | null;
}

/** Parse gml:pos text into {lat, lng}. The GML ships coordinates in the
 * Polish national grid "układ 2000 strefa 21" (TM, lon0=21, k=0.999923,
 * false easting 7 500 000 m) — verified empirically against Krakow. */
const PL2000_21 =
	"+proj=tmerc +lat_0=0 +lon_0=21 +k=0.999923 +x_0=7500000 +y_0=0 +ellps=GRS80 +units=m +no_defs";

function parsePos(text: string): { lat: number; lng: number } | null {
	const parts = text.trim().split(/\s+/).map(Number);
	if (parts.length < 2 || parts.some((p) => Number.isNaN(p))) return null;
	// The export writes <gml:pos> as "northing easting" despite the CRS
	// being easting/northing; detect each axis by its numeric range.
	const [a, b] = parts;
	const easting = a >= 7_400_000 && a <= 7_460_000 ? a : b;
	const northing = easting === a ? b : a;
	if (easting < 7_400_000 || easting > 7_460_000) return null;
	if (northing < 5_520_000 || northing > 5_580_000) return null;
	const [lng, lat] = proj4(PL2000_21, "WGS84", [easting, northing]);
	return { lat, lng };
}

interface ParsedGml {
	transactions: Map<
		string,
		{
			oznaczenie: string;
			rodzaj: string;
			rynek: string;
			cena: number;
			dokumentRef: string | null;
			nieruchomoscRef: string | null;
		}
	>;
	dokumenty: Map<string, string>;
	nieruchomosci: Map<
		string,
		{
			lokalRef: string | null;
			dzialkaRef: string | null;
			budynekRef: string | null;
			pos: { lat: number; lng: number } | null;
		}
	>;
	/** Geometry actually lives on the linked dzialka/budynek features. */
	dzialki: Map<string, { lat: number; lng: number }>;
	budynki: Map<string, { lat: number; lng: number }>;
	lokale: Map<
		string,
		{
			funkcja: string;
			pow: number;
			izby: number;
			kondygnacja: string;
			adresRef: string | null;
			pos: { lat: number; lng: number } | null;
		}
	>;
	adresy: Map<string, { ulica: string; numer: string }>;
}

export function parseGml(filePath: string): Promise<ParsedGml> {
	return new Promise((resolve, reject) => {
		const parser = new SaxesParser({ xmlns: false });

		const result: ParsedGml = {
			transactions: new Map(),
			dokumenty: new Map(),
			nieruchomosci: new Map(),
			dzialki: new Map(),
			budynki: new Map(),
			lokale: new Map(),
			adresy: new Map(),
		};

		let feature: FeatureRec | null = null;
		let currentTextField: string | null = null;

		parser.on("opentag", (node) => {
			const name = node.name.replace(/^(rcn|gml):/, "");
			// Top-level features never nest; nested elements that also start with
			// RCN_ (e.g. RCN_IdentyfikatorIIP inside a transaction) are ignored.
			if (name.startsWith("RCN_") && !feature) {
				feature = {
					type: name,
					id: (node.attributes["gml:id"] as string | undefined) ?? "",
					fields: {},
					refs: {},
					pos: null,
				};
				return;
			}
			if (!feature) return;

			const href = node.attributes["xlink:href"];
			if (typeof href === "string") {
				feature.refs[name] = href;
			}
			if (name === "pos") {
				currentTextField = "pos";
			} else if (TEXT_FIELDS.has(name)) {
				currentTextField = name;
			}
		});

		parser.on("text", (text) => {
			if (!feature || !currentTextField) return;
			if (currentTextField === "pos") {
				feature.pos = (feature.pos ?? "") + text;
			} else {
				feature.fields[currentTextField] =
					(feature.fields[currentTextField] ?? "") + text;
			}
		});

		parser.on("closetag", (tag) => {
			const name = tag.name.replace(/^(rcn|gml):/, "");
			if (currentTextField && (name === currentTextField || name === "pos")) {
				currentTextField = null;
				return;
			}
			if (!feature) return;
			// Nested elements may also start with RCN_ (e.g. RCN_IdentyfikatorIIP);
			// only the closing tag that matches the feature type ends it.
			if (name !== feature.type) return;
			const f = feature;
			feature = null;

			switch (f.type) {
				case "RCN_Transakcja": {
					const cena = Number.parseFloat(
						f.fields["cenaTransakcjiBrutto"] ?? "",
					);
					result.transactions.set(f.id, {
						oznaczenie: f.fields["oznaczenieTransakcji"] ?? f.id,
						rodzaj: f.fields["rodzajTransakcji"] ?? "",
						rynek: f.fields["rodzajRynku"] ?? "",
						cena: Number.isFinite(cena) ? cena : 0,
						dokumentRef: f.refs["podstawaPrawna"] ?? null,
						nieruchomoscRef: f.refs["nieruchomosc"] ?? null,
					});
					break;
				}
				case "RCN_Dokument":
					result.dokumenty.set(
						f.id,
						f.fields["dataSporzadzeniaDokumentu"] ?? "",
					);
					break;
				case "RCN_Nieruchomosc":
					result.nieruchomosci.set(f.id, {
						lokalRef: f.refs["lokal"] ?? null,
						dzialkaRef: f.refs["dzialka"] ?? null,
						budynekRef: f.refs["budynek"] ?? null,
						pos: f.pos ? parsePos(f.pos) : null,
					});
					break;
				case "RCN_Dzialka":
					if (f.pos) {
						const pos = parsePos(f.pos);
						if (pos) result.dzialki.set(f.id, pos);
					}
					break;
				case "RCN_Budynek":
					if (f.pos) {
						const pos = parsePos(f.pos);
						if (pos) result.budynki.set(f.id, pos);
					}
					break;
				case "RCN_Lokal":
					result.lokale.set(f.id, {
						funkcja: f.fields["funkcjaLokalu"] ?? "",
						pow: Number.parseFloat(f.fields["powUzytkowaLokalu"] ?? "") || 0,
						izby: Number.parseInt(f.fields["liczbaIzb"] ?? "", 10) || 0,
						kondygnacja: f.fields["nrKondygnacji"] ?? "",
						adresRef: f.refs["adresBudynkuZLokalem"] ?? null,
						// Coordinates come from <rcn:georeferencja><gml:Point><gml:pos>.
						pos: f.pos ? parsePos(f.pos) : null,
					});
					break;
				case "RCN_Adres":
					result.adresy.set(f.id, {
						ulica: f.fields["ulica"] ?? "",
						numer: f.fields["numerPorzadkowy"] ?? "",
					});
					break;
			}
		});

		parser.on("error", reject);
		parser.on("end", () => resolve(result));

		// saxes 6 emits events but is not a Writable stream, so feed it manually.
		const stream = createReadStream(filePath);
		stream.on("data", (chunk: string | Buffer) =>
			parser.write(chunk.toString()),
		);
		stream.on("end", () => parser.close());
		stream.on("error", reject);
	});
}

async function downloadIfMissing(): Promise<void> {
	if (process.env.RCN_GML_PATH) return; // test override: file already present
	await mkdir(DATA_DIR, { recursive: true });
	try {
		await stat(GML_PATH);
		console.log(`Using cached ${GML_PATH}`);
		return;
	} catch {
		// not cached yet, download
	}

	console.log(`Downloading ${RCN_ZIP_URL} ...`);
	const res = await fetch(RCN_ZIP_URL);
	if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
	await pipeline(
		Readable.fromWeb(res.body as never),
		createWriteStream(ZIP_PATH),
	);
	console.log("Extracting GML...");
	// The download is a ZIP archive containing a single .gml file.
	await new Promise((resolve, reject) => {
		createReadStream(ZIP_PATH)
			.pipe(Extract({ path: DATA_DIR }))
			.on("close", resolve)
			.on("error", reject);
	});
	await rm(ZIP_PATH);
	console.log(`Ready: ${GML_PATH}`);
}

async function importTransactions(): Promise<void> {
	await downloadIfMissing();

	console.log("Parsing GML (streams ~2 GB, this takes a few minutes)...");
	const {
		transactions: txMap,
		dokumenty,
		nieruchomosci,
		dzialki,
		budynki,
		lokale,
		adresy,
	} = await parseGml(GML_PATH);

	console.log(
		`Parsed: ${txMap.size} transactions, ${dokumenty.size} documents, ` +
			`${nieruchomosci.size} properties, ${lokale.size} lokale, ${adresy.size} addresses`,
	);

	const rows: Array<{
		transactionId: string;
		date: Date;
		price: number;
		pricePerM2: number | null;
		areaM2: number | null;
		rooms: number | null;
		floor: string | null;
		street: string | null;
		streetNumber: string | null;
		market: number | null;
		lat: number | null;
		lng: number | null;
	}> = [];

	let skippedNotSale = 0;
	let skippedNotFlat = 0;
	let skippedNoGeom = 0;
	let skippedNoDate = 0;
	let imported = 0;

	for (const tx of txMap.values()) {
		if (tx.rodzaj !== "1") {
			skippedNotSale++;
			continue;
		}
		const nier = tx.nieruchomoscRef
			? nieruchomosci.get(tx.nieruchomoscRef)
			: undefined;
		if (!nier || !nier.lokalRef) {
			skippedNotFlat++;
			continue;
		}
		const lokal = lokale.get(nier.lokalRef);
		if (!lokal || lokal.funkcja !== "1") {
			skippedNotFlat++;
			continue;
		}
		// The most precise point is the lokal's own <georeferencja>; fall
		// back to the linked nieruchomosc / dzialka / budynek geometry.
		const pos =
			lokal.pos ??
			nier.pos ??
			(nier.dzialkaRef ? dzialki.get(nier.dzialkaRef) : undefined) ??
			(nier.budynekRef ? budynki.get(nier.budynekRef) : undefined);
		if (!pos) {
			skippedNoGeom++;
			continue;
		}
		const dateStr = tx.dokumentRef ? dokumenty.get(tx.dokumentRef) : undefined;
		if (!dateStr) {
			skippedNoDate++;
			continue;
		}
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) {
			skippedNoDate++;
			continue;
		}

		const adres = lokal.adresRef ? adresy.get(lokal.adresRef) : undefined;
		const area = lokal.pow > 0 ? lokal.pow : null;

		rows.push({
			transactionId: tx.oznaczenie,
			date,
			price: tx.cena,
			pricePerM2: area ? tx.cena / area : null,
			areaM2: area,
			rooms: lokal.izby > 0 ? lokal.izby : null,
			floor: lokal.kondygnacja || null,
			street: adres?.ulica || null,
			streetNumber: adres?.numer || null,
			market: tx.rynek ? Number.parseInt(tx.rynek, 10) : null,
			lat: pos.lat,
			lng: pos.lng,
		});

		if (rows.length >= BATCH_SIZE) {
			await flush(rows);
			imported += BATCH_SIZE;
		}
	}

	await flush(rows);
	imported += rows.length;

	console.log(
		`Imported ${imported} apartment sales. Skipped: ${skippedNotSale} non-sales, ` +
			`${skippedNotFlat} without flat, ${skippedNoGeom} without geometry, ${skippedNoDate} without date`,
	);
}

async function flush(
	rows: Array<{
		transactionId: string;
		date: Date;
		price: number;
		pricePerM2: number | null;
		areaM2: number | null;
		rooms: number | null;
		floor: string | null;
		street: string | null;
		streetNumber: string | null;
		market: number | null;
		lat: number | null;
		lng: number | null;
	}>,
): Promise<void> {
	if (rows.length === 0) return;
	await db.insert(transactions).values(rows).onConflictDoNothing();
	rows.length = 0;
}

importTransactions().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
