# What we can read out of an offer, per source

The portals publish very different things. Before extending the LLM channel it
is worth knowing, for each source, **what the structured payload already
contains** (free and exact), **whether there is prose at all**, and therefore
**what is left for the model**. The table below comes from a sample of ten
sale offers per source plus a fill-rate count over every stored row of that
source (`listings`, November 2026, ~17.6k sale offers).

## The two channels

1. **Structured payload** (`features`, LD+JSON, portal API). Never guessed,
   always preferred. Consumed by `src/crawler/attributes.ts` and mege to
   columns.
2. **Prose** (`title` + `description`). Read only by the model
   (`src/lib/llm/`, prompt v5). This is the channel that fills heating,
   building style, condition, plot media and the rest, because the bulk feeds
   publish almost none of it.

A third, implicit channel matters just as much: **whether the prose exists at
all**. Several sources give a truncated teaser, not the offer text.

## Prose availability, per source

| Source | Text we get | What that means |
|---|---|---|
| otodom | Full text, but only on detail pages (12% of rows carry one, 104/838 carry detail attributes) | The richest source of detail attributes **and** prose, but the CDN rate-limits detail crawls, so the 8-page budget per run covers a fraction. Everything else is invisible to the model. |
| olx | Full text, `<br />`-separated | Good prose: rooms, exposure, condition, costs all stated. |
| sprzedajemy | Full text + Polish-keyed attributes (`rok budowy`, `liczba pięter`, `szerokość`, `długość`, `zabudowa`) | Good prose; its own attributes duplicate what the model would extract. |
| adresowo | Full text | Good prose (owner ads, marketing + facts). |
| nieruchomosci-online | Full text + rich LD+JSON (`roof_type`, `exterior_walls`, `building_management`, `renovation_needed`, `basement_access`, `terrace`, `garage`, `floor_level`, `land_area`) | The single best structured source; the model is only needed for what the detail attributes miss. |
| gethome | Full text + structured (`shape`, `lot_size`, `garden`, `balconies`, `terraces`, `bathrooms`, `building_floors_num`, `lot_type`) | Good on both channels. |
| tabelaofert | Full text + structured (`układ okien`, `strony świata`, `liczba poziomów`, `winda`, `garaż`, `typ kuchni`, `wyposażenie terenu`, `termin oddania`) | Good on both channels; unit inventory from the investment page. |
| elicytacje-mf | Long legal description + structured auction fields | Rich prose: parcels, media, road access, buildings on the land. |
| mapalicytacji | Short prose + auction fields | Enough for parcel/area/building facts, thin on the building itself. |
| budujesie | Forum posts | Investor chatter: developer, stage, unit counts, price claims. Not offer facts; use it for the investment, not the unit. |
| morizon, gratka | **Truncated teaser ending in "..."** | The model sees the first sentence only. Facts need a detail pass (`description` is currently a snippet). |
| domiporta | **Truncated teaser ending in "..."** | Same as morizon/gratka. |
| rynekpierwotny | **No description** (project rows) | Nothing to read; keep it as an investment/price point. |
| investmap | **No description** (unit rows; investment rows carry no price) | Nothing to read; unit facts come from the price list fields. |
| licytacje-komornik | **No description**, the legal notice lives in the title | The model must read the *title*: area, rooms, address, land register, building type, share. |

Consequence: for morizon, gratka, domiporta and licytacje-komornik the model
currently reads a teaser or a title. Two cheap improvements, independent of
the schema: fetch the detail page for morizon/gratka/domiporta (one request
per row, cached like the other detail passes), and normalise the komornik
title before extraction (the notice format is regular).

## Fill rates that justify the model channel

Share of sale rows with a non-null value, per source (excerpt):

| Field | Best source | Typical |
|---|---|---|
| heating | otodom detail, olx, sprzedajemy | 0-33% everywhere else |
| build year | nieruchomosci-online (59%) | 0-17% elsewhere |
| condition | sprzedajemy 22%, olx 10% | 0-5% elsewhere |
| ownership | olx 52%, sprzedajemy 25% | 1-18% elsewhere |
| floor count | nieruchomosci-online 36%, gethome 29% | 0-12% elsewhere |
| market | investmap/tabelaofert/rynekpierwotny/gethome 100% | otodom 12%, everyone else 0-17% |
| admin fee, deposit | olx 7%, adresowo 5% | 0% essentially everywhere |
| amenities (balcony, parking, lift) | olx 15-43% | 1-13% elsewhere |

So the model channel is not a nice-to-have: on most sources it is the only
source of heating, age, condition, costs and amenities.

## Fields worth extracting that we do not extract yet

Grouped by how the value is used. `v3` marks what prompt v3 added (v4 adds
`market` and the once-per-offer contract below; v5 turns the model on passing
mentions of the building kind and the heating source).

**Building (any segment)**
- `renovationYear` (v3) - "dach wymieniony w 2019", "po remoncie w 2020".
- `energyClass` (v3) - świadectwo energetyczne, "klasa C", "EP 80".
- `elevationState` (v3) - elewacja po ociepleniu / do remontu.
- `roofType`, `roofYear` (v3) - dachówka, blacha, papa; frequently stated for houses and tenements.
- `garret` (v3) - poddasze/strych, użytkowe czy nie.

**Flat**
- `storageM2` (v3) - komórka lokatorska (dimension, not just a boolean).
- `parkingType` (v3) - hala garażowa / garaż / miejsce naziemne / brak.
- `balconyGlazed` (v3) - balkon zabudowany (loggia).
- `topFloor` (v3) - ostatnie piętro (a real downside, and a loft signal).
- `deposit` (v3, in `monthlyCosts`) - kaucja.

**House**
- `outbuildings` (v3) - budynki gospodarcze, stodoła, warsztat.
- `waterSource`, `sewage` (v3) - sieć / studnia / szambo / oczyszczalnia.
- `pool`, `sauna`, `jacuzzi` (v3) - holiday-house amenities, the 2027.15 target.
- `strEvidence` (v3) - the ad claims tourist rental or occupancy; feeds the holiday-house rental signal.
- `plotSubdividable` (v3) - possible subdivision, a value driver for large plots.

**Plot**
- `maxCoveragePct`, `maxFloors` (v3) - MPZP parameters stated in prose ("zabudowa do 35%, 1,5 kondygnacji"). What a developer actually needs.
- `existingBuilding` (v3) - a building already stands on the parcel.
- `plotSubdividable` (v3, as above).

**Auction (komornik, eLicytacje, mapalicytacji)**
- `appraisedValue` (v3) - oszacowanie; the starting price is a fraction of it, and the ratio is the real signal.
- `auctionRound` (v3) - pierwsza/druga licytacja (the second starts at 2/3 of the appraisal).
- `caseNumber`, `court`, `landRegister` (v3) - sygn. akt, sąd, KW number: what a bidder must check.
- `shareFraction` (v3) - "udział 1/2" (structured on eLicytacje, prose elsewhere).

**Investment (new-build rows)**
- `constructionStage` (v3) - planned / foundations / shell / closed shell / finishing / completed.
- `unitsCount`, `buildingsCount` (v3) - scale of the development.
- `finishStandard` (v3) - deweloperski / pod klucz / do wykończenia.
- `siteAmenities` (v3) - playground, gym, concierge, coworking, pool, underground parking.

**Already extracted in v2** and kept: heating, building type, large panel,
plot type, material, condition, ownership, build year, plot area, floor,
floor count, the amenity booleans, utilities, road access, MPZP symbol and
purpose, WZ, plot shape/slope/dimensions, fencing, kitchen, exposure,
windows, technology, insulation, floor heating, heat pump, recuperation, air
conditioning, photovoltaics, parking spots, balcony/terrace/garden/garage
areas, legal status, encumbrances, defects, context (lake/river/forest/
mountains/view), tenanted, urgency, monthly costs.

## One call per offer

The model is called from exactly one place (`src/lib/llm/extract.ts`) and each
offer reaches it at most once per text version:

- the stored `source_hash` covers the prompt version, the title and the exact
  description that was sent (stored whole under one 20 000-char cap), so
  editing an ad or re-crawling it does not trigger a call;
- an answer that contains nothing is stored as `{}` with the hash, so a text
  with no extractable facts converges instead of being retried every run;
- a row the model omits from an otherwise valid answer is stored the same way,
  while a failed or unparseable batch writes nothing and is retried;
- title-only offers (komornik notices, investmap rows) are sent too, because
  their facts live in the title;
- scoring and alerting never call the model: they read `listing_facts`
  through `ScoredFacts`, and `validate:facts` fails if any other module
  imports the client.

## How it is wired

- Every site crawl reads its own offers before the row is stored:
  `crawlSite -> extractFactsForListings -> saveListings -> scoreArrivals`.
  The inline pass sends the crawl's title+description to the model, the sink
  writes the listing and its facts together, and scoring runs on the enriched
  row. A failed batch saves the offers without facts and the refresh's
  `listing-facts` phase retries them.
- `src/lib/llm/listing-facts.ts` - vocabulary, prompt, parsing, normalisation,
  whole-ad batching (pure; `validate:facts` pins it).
- `src/lib/llm/extract.ts` - the inline pre-store pass, the database drain,
  text hashing, storage in `listing_facts`, promotion of the subset scoring
  reads into columns.
- `src/lib/llm/fact-access.ts` - the projection scoring consumes
  (`ScoredFacts`).
- New v3 fields live in `listing_facts.facts_json` and reach the API/card
  through `fact-access.ts`; only fields that change a score are promoted to a
  column, so extending the vocabulary costs no migration.

## Known limits

- The model is a data source, not a trusted one: every value is checked
  against the vocabulary, ranges and negation rules, and an unstated fact is
  null/false, never a guess.
- A teaser is not an offer: morizon/gratka/domiporta facts are only as good
  as their first sentence until a detail pass lands.
- `investmap`, `rynekpierwotny`, `budujesie` and `licytacje-komornik` rows
  carry no usable prose; for them the structured payload and the title are
  the whole input.
