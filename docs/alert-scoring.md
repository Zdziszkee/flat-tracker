# Alert scoring 2027.16

Transparent scoring for sale offers in Małopolskie and Śląskie. No ML
model participates in the score. The job stores every component, reason
and risk flag so an alert can be audited later. Scoring is incremental: the
crawl pipeline scores each newly saved offer immediately, the end of every
`refreshAll()` scores anything still missing a current-version score
(`incremental: true`) and appends the new top-25-per-segment offers to
today's alert list; the daily 06:30 task additionally re-scores recent
offers.

## Research basis

- Geerts, vanden Broucke and De Weerdt (2025) benchmark GNNs against tree
  models on six housing datasets. GNNs did not beat LightGBM or CatBoost, so
  this design uses deterministic rules, not a graph model.
- TabPFN-2.5 (2025) is the leading tabular foundation model, but it targets up
  to 50k rows. The RCN set is much larger and a rules engine does not need it.
- Spatially weighted conformal prediction is the current best practice for
  AVM uncertainty. The future interval layer should use it, not a global
  residual quantile.
- LLMs are useful for extracting tags and writing explanations. They
  underestimate uncertainty and reason poorly about space, so they are not in
  the score path.

## Score

`total = 50 + (weighted_raw - 50) * (0.65 + 0.35 * confidence)`

On top of that weighted score, a small set of observed amenities adds points
(`src/lib/scoring/config.ts`, `AMENITY_BONUSES`):

| Amenity | Points | Range |
|---|---:|---|
| Ogrzewanie miejskie / pompa ciepła | 5 | heating field |
| Przystanek tramwajowy | 5 | 300 m, flat in Kraków/Katowice |
| Dworzec kolejowy | 5 | 1 km |
| Park | 3 | 300 m |
| Woda | 2 | 500 m |
| Winda | 2 | flag |
| Miejsce postojowe / garaż | 2 | flag |

The bonus is applied against the remaining headroom:
`bonus * min(1, (100 - weighted) / 30)`. A weak offer gets the full +5 for a
tram stop, a 90-point offer gets about +1.7, and no two offers collapse into
the same 100. Each bonus is a separate, named reason on the alert card, so
the points are auditable.

Segment weights:

| Segment | Value | Transit | Green | Property | Risk |
|---|---:|---:|---:|---:|---:|
| flat | 0.30 | 0.20 | 0.20 | 0.25 | 0.05 |
| house | 0.30 | 0.10 | 0.30 | 0.25 | 0.05 |
| plot | 0.25 | 0.15 | 0.28 | 0.27 | 0.05 |

Value carries less than a third of the flat score because a 30% swing in
asking price is common; location, building quality and risk decide more of the
ranking than the discount alone. In 2027.14 the flat property weight rose to
0.25 (a tenement in the centre zone is the target, and its building style and
condition are the evidence) and plots moved weight into transit because
fast-rail access is the reason a plot is on the list. In 2027.15 houses moved
weight to green and property: the holiday-house target ranks a wooden cottage
alone by a lake above a suburban house with a station next door.

### Eligibility

Three hard rules sit before the discount gate. A failing offer is still
scored and kept in the table, but it can never enter the leaderboard
(`listing_scores.eligible = false`):

- **Flats**: district heating or a heat pump, no old block, and a position
  inside the centre zone (4 km from any anchor in
  `src/lib/scoring/centre-zone.ts`: Rynek Główny, Kazimierz, Podgórze,
  Krowodrza, Grzegórzki, Dębniki, Zwierzyniec, Wola Justowska, Katowice
  Rynek). Gas, electric, coal and oil fail as `non_municipal_heating`; an old
  block fails as `old_block` (a large-panel building, or a block proved to
  predate 2000, see `src/lib/building-class.ts`). Tenements, new blocks
  (2000+), apartment buildings and blocks whose age nobody stated are
  allowed. Missing heating evidence fails as `no_heating_evidence`, the only
  flat failure a short section may fill from (see below).
- **Plots**: buildable land only, inside 20 km of a fast-rail station.
  Building evidence is the portal plot type (budowlana / inwestycyjna), an
  EGiB land-use class in B*, MN, MW or RM, a WZ decision, a zoning plan, or
  the same evidence read out of the ad by the extractor (WZ, MPZP symbol or
  purpose, declared plot type). A plot fails as `not_building_plot`, and as
  `outside_fast_rail` when no `FAST_RAIL_STATIONS` entry is within
  `FAST_RAIL.gateRadiusM` (20 km). The gate is a catchment, not the walkable
  ring: a 3 km radius around six stations left the Działki section empty
  (5 of 644 live plots, none with a comparable), while the distance bands
  still reward proximity down to 800-2000 m.
- **Houses** are a different product with different gates: a unique holiday
  property for short-term rental, not spare land. A house needs a nature
  setting (`no_nature_setting`: water within 1 km, forest within 800 m, or a
  lake/river/forest/mountains setting the extractor read) and character
  (`no_house_character`: wood, pre-1980, a 1500 m²+ plot, or real solitude).
  Buildability and the fast-rail radius do not apply to houses; see
  "Holiday houses".
- **Comparable sample**: fewer than three comps in the estimate.

Gates are evaluated independently, so a score records every failure rather
than stopping at the first one. Two consequences: a flat can fail both
heating and the discount, and the leaderboard can tell a flat that failed
*only* on evidence the extractor could not find from one that failed on a
fact the ad states. The first case is `fallback_eligible`: when a section
cannot fill `ALERT_TOP_OFFERS` (25) with fully eligible offers, the remainder
comes from this pool, ranked below every eligible offer and marked on the
card. A gas-, electric-, coal- or oil-heated flat, or a flat proved to sit in
a modern block, is never a fallback.

Heating and building style are read from three places, in order of
authority: the structured column, the portal attribute blob
(`features.heating`), and the LLM facts (`listing_facts`, read by every crawl
before the offer is stored and repaired by the `listing-facts` phase). Prose
is read by the extractor only. The regular-expression
pass over the description was removed in 2027.14: it matched negations and
neighbourhood mentions ("bez ogrzewania miejskiego", "blisko miejskiej
pływalni"), and the model reads the same sentence with the ad's context. A
regression check pins that a description alone no longer satisfies the
heating gate.

### Location targets

Two curated datasets, both listed on /sources as static layers
(`planned-rail`) and both pinned by `bun run validate:planned-stations`:

- **Fast rail** (`src/data/fast-rail-stations.ts`): stations served by
  200 km/h+ trains in Małopolska and Śląskie (Kraków Główny, Katowice,
  Zawiercie, Tychy, Bielsko-Biała Główna, Gliwice), each tagged with the
  services it carries. The planned KDP service reaches Kraków and Katowice
  through the modernised CMK from 2035, so those stops carry `kdp_2035`.
  160 km/h corridors are deliberately excluded: they would make the gate
  meaningless. Coordinates are the OSM station nodes the map already renders.
- **Centre zone** (`src/lib/scoring/centre-zone.ts`): explicit anchors for the
  target neighbourhoods, because only about a third of the Kraków rows carry a
  district name and "Podgórze" spans 15 km of the city. Distances are measured
  to the nearest anchor in the listing's own city.

### Holiday houses

A house alert is a bet on something a short-term renter cannot get in a city:
wood, age, space, and nobody next door, with water, forest, mountains or a
park around it. The signals come from data the project already holds, not
from adjectives in the ad:

- **Character** (`houseCharacter` in `alert-score.ts`, deltas on the property
  component): wood / log / timber-frame construction +12, `technology =
  framed` +6, pre-war (`prewarBuiltBefore` 1945) +10 or built before
  `retroBuiltBefore` (1980) +6, a plot of 1500 m² or more +6, nothing within
  `wildernessM` (500 m) +20 (250 m+ +14, 100 m+ +10), no other building within
  150 m +10 (at most four +4), and a neighbour closer than 25 m -12. The gate
  needs at least one positive entry.
- **Isolation** (`src/lib/scoring/house-nature.ts`) is measured, not claimed:
  the nearest other building and the count within 150 m come from the local
  `osm_buildings` index (3.2M footprints), with the house's own footprint
  (anything within 20 m) ignored. The query rides the bbox index and is cached
  per 250 m cell, so a street of offers costs one query.
- **Nature**: water within 1 km, forest within 800 m, a park within
  `natureParkM` (500 m), or a forest/water share of the 500 m/1 km disc; the
  extractor's `context` adds what geometry cannot see (a lake across the road,
  a mountain view).
- **Short-term-rental market**: the median nightly price of the airbnb and
  booking rows within 2 km, from the same crawler that already stores 11.6k
  short-term offers. `STR_MARKET` turns it into +2/+4/+6 points above
  250/400/600 zł per night and refuses a sample under five offers. Offer
  **density** in the same disc is the area-level signal: 30/60/120 visible
  short-term offers add +2/+4/+6, and plots read the density too, because a
  holiday plot is making the same bet on the area.
- **Bonuses** on top of the weighted score: water within 300 m +8, forest
  within 300 m +6, a park within 500 m +5, mountains +4, solitude +6, and
  "in the wild" (nothing within 500 m) +8. The card shows the isolation
  distance and the local nightly median so the number can be checked.

### Plot green/water tiers

For plots, a forest or lake on the same parcel (approximated by the parcel
radius plus 20 m) is worth three times the base amenity value; the same
feature within 3 km is worth a third; beyond 3 km nothing is granted.


### Value

The fair value comes from time-adjusted RCN comparables in `offer-model.ts`,
with active asking offers as the fallback when fewer than three RCN comps
survive. The headline discount uses the RAW asking price against the local
comparable median — no negotiation margin, because the comparables already
carry the asking-vs-transaction wedge.

`discount = 1 - asking / fair`

`value_score` is the piecewise-linear `VALUE_CURVE` on that discount:
0% → 50, 10% → 80, 20% → 95, 30%+ → 100 (saturating cap).

Listing-only comparable sets are trusted at a 0.85 value-confidence factor
(RCN-backed sets use 1.0), so a fresh database without the RCN import can
still produce alerts, at visibly lower confidence.

**Plot-specific listing-only policy (2027.6).** RCN publishes very few pure
land transactions, so a listing-only comp set is the structural norm for
plots, not a temporary data gap. The offer-model confidence level is built
for RCN-backed unit comps and caps every RCN-less set at "low" (0.45),
which combined with the plot weights made the 0.5 confidence gate
mathematically unreachable. For plots with fewer than three RCN comps:

- base confidence 0.65 (`PLOT_LISTING_BASE_CONFIDENCE`) replaces the
  RCN-oriented level; RCN-backed plot sets keep the reported level,
- listing-only factor 0.9 (`PLOT_LISTING_RCN_FACTOR`): land asks are more
  homogeneous and less negotiable than unit asks,
- comp-spread decay floored at 0.7 (`PLOT_SPREAD_FACTOR_FLOOR`): land comp
  sets mix building, agricultural and recreational plots, so a wide spread
  does not mean the median is wrong. The `wide_comp_spread` risk flag stays.

Flats and houses keep the generic treatment (0.45 base, 0.85 factor, no
spread floor). The constants live in `config.ts` with the full rationale.

**The comparable median is nominal and quality-corrected (2027.14).** Two
corrections sit between the comps and the number the card shows:

- **Time**: every RCN comparable is brought to today with the chain-linked
  quarterly index (`timeFactor`), which is nominal, so inflation and real
  market growth are both inside it. A comp from 2019 is multiplied by the
  index ratio between its quarter and the current one; the median factor and
  the index period span are stored with the score
  (`listing_scores.valuation_json`) and shown on the card.
- **Quality**: `src/lib/valuation/quality-factor.ts` adjusts the comp median
  for the subject's own condition and building quality, read from the
  extracted facts (condition, build year, technology, insulation, floor
  heating, heat pump, AC, PV, parking, legal status, defects, encumbrances,
  tenanted) and, for plots, the media/access/plan/shape/slope evidence. The
  deck is two-sided and balanced (a "do remontu" flat about -11%, an
  "excellent" one about +9%), the total is clamped to +-15%, no facts means a
  neutral 0%, and every component is a named reason on the card. The
  correction is applied to `fairM2`, `fairPrice` and the low/high band before
  the discount and the upside are computed, so the score and the forecast see
  the same value.

Asking-price comparables (used only when fewer than three RCN comps survive)
are converted to the transaction level with a measured asking-to-transaction
ratio (`src/lib/valuation/asking-ratio.ts`): the median asking zl/m2 of
visible offers against the median RCN zl/m2 of the same quarter and region,
with a minimum sample per side and a documented fallback when the sample is
thin. The ratio and its provenance ("measured" or "fallback") travel with the
estimate.

### Transit

Tram and train are deliberately different signals. Tram counts only for flats
in Kraków and Katowice, gated by the listing's structured `city` rather than
`geo.city` (the latter is just the nearest external price-index centre and
would label Zakopane as Kraków). The city string is normalized for case and
diacritics, so `Kraków`, `KRAKÓW` and `Krakow` all qualify. A stop within 300 m
is the full-credit target; the score then decays through 600, 1000, 1500 and
3000 m. Outside those cities, tram gets zero weight and that weight moves to
train, bus and the city centre.

Train station distance has its own bands and applies to every segment. It
peaks at 300-800 m, stays preferred below 2000 m, and is penalized under 150 m
because a station at the doorstep is noise rather than convenience.

Fast-rail access (`FAST_RAIL.bands`) is the house and plot signal: full credit
at 1.5 km, still strong at 2 km, 70 at the 3 km gate edge, and it carries half
of their transit component (25% trains, 10% bus, 15% centre). Flats use the
centre-zone band instead (full credit within 500 m of an anchor, 55 at the
4 km gate edge) and keep the tram signal, which owns 45% of their transit
score inside a tram city.

A heavy-rail line within 200 m still lowers the transit score and adds
`rail_noise`; tram tracks are stored separately and never create that flag.

### Green

Park distance, forest distance plus forest share within 500 m, and lake or
river distance plus water share within 1 km. Forest and water shares are
sampled on a 5x5 grid from OSM polygons.

### Property

Flats: floor, elevator, build year, condition, building style, material,
heating, ownership, balcony, terrace, garden, parking, garage, basement,
rooms.

Large-panel blocks (`blok`, `wielka płyta`, `concrete_plate`, `block`) lose
12 property points, tenements (`kamienica`, `tenement`) gain 10, and
purpose-built apartment buildings (`apartamentowiec`, `apartment`) gain 8.
The detector reads the structured `building_type` and `building_material`
first and only falls back to title/description text when neither carries a
recognizable style, so a mention of a nearby block in an offer title cannot
override a portal's building type. A structured style is applied once, not
stacked with its material.

District heating (`miejskie`, `c.o. miejskie`, `sieć`, `district`, `urban`)
gains 8 points in flat and house scores. Gas (`gazowe`, `gas`) loses 7 and
electric resistive heating (`elektryczne`, `electric`) loses 12, reflecting
the user-facing cost ordering. Heat pumps keep the existing +8 as the
efficient exception.

Houses: plot size, building type, condition, material, heating, ownership,
garage, garden, parking.

Plots: plot type, area, road distance and class, WZ, MPZP count, no-plan flag,
flood risk, slope, building coverage, and media or permit mentions in the
description. Phrases such as "bez mediów" or "media do podłączenia" count
against the plot instead of for it.

### Risk and gates

Risk starts at 85 and subtracts for missing coordinates, no comps, few comps,
wide spread, rail noise, flood risk, leasehold, share ownership, auction and
missing price or area.

An offer enters the alert list only when:

- `value_score >= 55`
- `confidence >= 0.5`
- `discount >= 10%`
- the coordinates are not a shared placeholder (`placeholder_coordinates`)
- the discount is credible: below 35% always, 35-55% only on a broad
  (`>= 15` comps) and tight (`spread <= 25%`) sample, never past 55%
- the median index factor that carries the comps to today is inside
  `0.9-1.6` (`broken_index_factor`); `1.35-1.6` costs `high_index_factor`
  risk points without rejecting the offer

The plausibility gates exist because a "discount" is only as good as its
comparables. The 2027.14 list carried a 1000 m² village plot at 94% below
the local median, a 156 m² industrial plot at 85% and ordinary estate flats
at 33-44%: those were broken comp sets (land of another type, a city-centre
placeholder location, a thin cell index), not bargains, and a leaderboard
that ranks them first is worse than an empty one.

The daily leaderboard is the best `ALERT_TOP_OFFERS` offers (25) per
segment (flats, houses, plots) across both tracked regions, computed over
the whole scored, active pool. Today's list is replaced on every run with
the current cut (older dates are untouched), so a better offer that appears
during the day is shown and one that loses its place disappears; the row
keeps its original `createdAt` for the freshness badge. Re-runs are
idempotent through the unique `(listing, alert_date, channel)` index. The
alert row records the rule it was created under
(`payload_json.cut = "top25"`), which keeps legacy 5%-era rows
identifiable. The alerts page always shows the three segments (Mieszkania,
Domy z działką, Działki) as side-by-side sections, even when a section is
empty, and `/api/alerts` enforces the same 25-per-segment ceiling on the
response.

Selection is deduplicated and diversified: the same offer syndicated on two
portals (`city + street + area in m² + 1% price band`) keeps one row, and a
single investment fills at most `ALERT_MAX_PER_INVESTMENT` (2) slots, freed
positions going to the next distinct offer. The live list had half a column
in one investment (five units of one osiedle, six of another) and three
literal duplicates.

These are selection rules, not scoring rules: they change which scored offers
become alerts, never a stored score, so they do not need a `SCORE_VERSION`
bump.

## Fresh arrivals

A newly saved offer is scored the moment the crawl stores it
(`scoreArrivals` from `src/crawler/pipeline.ts`), and it is appended to
today's alerts when it beats the offers that arrived in the previous 24
hours in the same region and segment.

- The cohort is current-version scores joined to `listings` where
  `coalesce(firstSeenAt, listedAt, scrapedAt)` falls in the 24 h window. The
  new offer competes inside its own cohort, because its score is stored
  before the comparison.
- The cut is `ALERT_FRESHNESS.topPercent` (5%, at least one position). A lone
  arrival is its own leader; ties share a rank, so a tie never displaces an
  incumbent. The gates (value score, confidence, discount) still decide
  whether the offer is eligible at all.
- The alert row carries `payload_json.reason = "fresh_arrival"` and the
  cohort size, so `/api/alerts` can label it. Insertion is
  `onConflictDoNothing` on `(listing_id, alert_date, channel)`, and already
  scored ids are skipped, so a re-run inserts nothing.
- This is an additional path, not a replacement: the market-wide top-25 cut
  still runs at the end of the refresh, so a fresh offer that misses its
  24-hour cohort can still enter through the full pool.
- Scoring is advisory in the crawl: a failure is logged and swallowed, and
  the final `scoring` phase cleans up anything the inline pass missed.

## Data and tables

- `listing_scores`: one row per listing per score version, with components,
  reasons, amenities and flags. `comp_count`/`comp_rcn_count` record how many
  comparables the valuation median used (total and RCN-only); `0` means the
  count was not recorded (rows written before the columns existed), not "no
  comparables". `amenities_json` carries the nearest park, forest, water,
  station, transit, tram and bus names next to their distances.
- `listing_alerts`: one row per listing per day per channel, with a unique
  index that makes the job idempotent.
- `src/lib/scoring/config.ts`: versioned policy constants.
- `src/lib/scoring/alert-score.ts`: pure scoring engine.
- `src/lib/scoring/run.ts`: batch run, ranking and alert creation
  (`incremental` scores only offers without a current-version score).
- `server/tasks/score-listings.ts`: daily task at 06:30; the refresh pipeline
  runs the same engine incrementally in its `scoring` phase.
- `src/routes/api/alerts.ts`: shared alert feed.
- `src/routes/alerts.tsx`: shared in-app list.

## Validation

`bun run validate:scoring` checks the pure scoring rules (plus stored-data
invariants). `bun run validate:planned-stations` pins the station and anchor
datasets (coordinates inside the tracked regions, unique ids, hand-computed
distances, target anchors present). `bun run validate:quality` pins the
condition deck, the clamp, monotonicity and the asking-ratio rules, and
`bun run measure:asking-ratio` prints the measured ratio table for audit.

- discount, park, forest and water are monotonic; tram improves inside its
  300 m target band
- tram earns full credit within the 300 m target in Kraków and Katowice, and is
  ignored for flats elsewhere and for houses/plots even in tram cities
- rail noise lowers transit and is flagged
- houses and plots prefer a station below 2000 m; a station at the doorstep is
  still penalized
- media, WZ and MPZP increase plot score
- flood risk lowers plot score and is flagged
- building style: large-panel facts lower flat property score and block the
  alert, kamienica and apartamentowiec raise it, extracted style beats the
  portal column
- heating cost order: district > gas > electric
- heating and building style come from the extracted facts: a description
  that names municipal heating no longer satisfies the gate on its own
- fast rail: a plot inside 20 km is eligible, 24 km fails as
  `outside_fast_rail`, and a closer station scores higher
- centre zone: a flat in Nowa Huta fails as `outside_centre_zone`, Wola
  Justowska passes, a block proved to predate 2000 fails as `old_block`, a
  new block and a block with no stated age pass, and a gas-heated new block
  is never a fallback
- holiday house: a wooden house alone by the water is eligible without any
  station, an ordinary suburban house fails the character gate, a house with
  no water/forest/mountains fails the nature gate, farmland no longer
  disqualifies a house, and solitude plus a strong STR market raise the score
- buildability (plots): a plot on agricultural land with no plan or WZ fails
- gates reject missing comps, thin comps and near-fair offers
- fresh arrivals: above the cohort cut alerts, below does not, the boundary
  holds for 5-of-100 and 1-of-20 cohorts, a lone arrival alerts, ties are
  conservative, an empty cohort alerts nothing, and the gates stay the sole
  blocker for a weak offer
- placeholder coordinates, an implausible discount (55%+), an unverified
  discount (35-55% on a thin or wide sample) and a broken index factor
  reject the offer; a high-but-possible factor only costs risk points
- stored scores are bounded, alerts respect gates, no duplicate alerts

`bun run typecheck` and `bun run build` pass.

## Limits

- The score is a ranking aid, not an appraisal.
- Asking prices are not transaction prices. The 15% margin is a policy input,
  not a per-listing estimate.
- Outcome precision at 5% needs sale outcomes. Until then, use the alert list
  as a shortlist and review the comparables.
- Land values remain sensitive to zoning, access and utilities. The parcel
  score uses the available `parcel_features` and text mentions, not a survey.
