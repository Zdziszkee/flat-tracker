# Alert scoring 2027.11

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
| flat | 0.35 | 0.22 | 0.18 | 0.20 | 0.05 |
| house | 0.35 | 0.10 | 0.25 | 0.25 | 0.05 |
| plot | 0.30 | 0.05 | 0.30 | 0.30 | 0.05 |

Value carries less than half the flat score because a 30% swing in asking
price is common; location, building quality and risk decide more of the
ranking than the discount alone.

### Eligibility

Three hard rules sit before the discount gate. A failing offer is still
scored and kept in the table, but it can never enter the leaderboard
(`listing_scores.eligible = false`):

- **Flats**: no large-panel block (`blok` / `wielka płyta` / `block`), and
  district heating or a heat pump. Gas, electric, coal and unknown heating
  are excluded.
- **Plots**: building evidence only. An explicit building plot type, a
  built-up EGiB land-use class, a zoning decision (WZ) or a zoning plan
  qualifies; farmland, recreational land and plots with no such evidence do
  not.
- **Comparable sample**: fewer than three comps in the estimate.

Heating and building style are read from three places, in order of
authority: the structured column, the portal attribute blob
(`features.heating`), and the prose. The prose is covered twice: the cheap
regular-expression pass in `src/lib/scoring/heating.ts` (runs during
scoring, so every offer gets it) and the model extraction in
`src/lib/llm/` (phase `listing-facts`), which fills the columns for the
corpus. Neither guesses: no evidence means unknown, and unknown fails the
municipal-heating gate.

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
because a station at the doorstep is noise rather than convenience. Houses and
plots give the station 70% of their transit component because they are not tram
markets; flats keep a train contribution but rely mainly on tram where one
exists. A heavy-rail line within 200 m still lowers the transit score and adds
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

This is a selection rule, not a scoring rule: it changes which scored offers
become alerts, never a stored score, so it does not need a `SCORE_VERSION`
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

`bun run validate:scoring` checks the pure scoring rules (plus stored-data invariants):

- discount, park, forest and water are monotonic; tram improves inside its
  300 m target band
- tram earns full credit within the 300 m target in Kraków and Katowice, and is
  ignored for flats elsewhere and for houses/plots even in tram cities
- rail noise lowers transit and is flagged
- houses and plots prefer a station below 2000 m; a station at the doorstep is
  still penalized
- media, WZ and MPZP increase plot score
- flood risk lowers plot score and is flagged
- building style: block/wielka płyta lowers flat property score, kamienica
  and apartamentowiec raise it, structured values beat title text
- heating cost order: district > gas > electric
- gates reject missing comps, thin comps and near-fair offers
- fresh arrivals: above the cohort cut alerts, below does not, the boundary
  holds for 5-of-100 and 1-of-20 cohorts, a lone arrival alerts, ties are
  conservative, an empty cohort alerts nothing, and the gates stay the sole
  blocker for a weak offer
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
