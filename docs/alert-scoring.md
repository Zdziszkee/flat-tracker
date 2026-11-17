# Alert scoring 2027.7

Transparent scoring for sale offers in Małopolskie and Śląskie. No ML
model participates in the score. The job stores every component, reason
and risk flag so an alert can be audited later. Scoring is incremental: the
end of every `refreshAll()` scores each offer that has no current-version
score yet (`incremental: true`) and appends the new top-5% offers to today's
alert list; the daily 06:30 task additionally re-scores recent offers.

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

Segment weights:

| Segment | Value | Transit | Green | Property | Risk |
|---|---:|---:|---:|---:|---:|
| flat | 0.50 | 0.20 | 0.10 | 0.15 | 0.05 |
| house | 0.45 | 0.10 | 0.15 | 0.25 | 0.05 |
| plot | 0.40 | 0.05 | 0.15 | 0.35 | 0.05 |

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

Tram, railway station, bus and city centre use distance bands. A railway line
within 200 m lowers the transit score and adds `rail_noise`.

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

Top 5% is computed per region and segment over the whole scored, active
pool. Each run appends the offers that newly rank in the top 5%; a listing
is alerted at most once, so the list grows incrementally as new offers come
in. The alerts page always shows the three segments (Mieszkania, Domy
z działką, Działki) as separate sections, even when a section is empty.

## Data and tables

- `listing_scores`: one row per listing per score version, with components,
  reasons, amenities and flags.
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

`bun run validate:scoring` checks 30 properties (plus stored-data invariants):

- discount, tram, park, forest and water are monotonic
- rail noise lowers transit and is flagged
- station at the doorstep is penalized against 900 m
- media, WZ and MPZP increase plot score
- flood risk lowers plot score and is flagged
- building style: block/wielka płyta lowers flat property score, kamienica
  and apartamentowiec raise it, structured values beat title text
- heating cost order: district > gas > electric
- gates reject missing comps, thin comps and near-fair offers
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
