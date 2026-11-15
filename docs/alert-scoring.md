# Alert scoring 2027.1

Transparent daily scoring for sale offers in Małopolskie and Śląskie. No ML
model participates in the score. The daily job stores every component, reason
and risk flag so an alert can be audited later.

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
| flat | 0.50 | 0.20 | 0.15 | 0.10 | 0.05 |
| house | 0.45 | 0.10 | 0.25 | 0.15 | 0.05 |
| plot | 0.40 | 0.10 | 0.30 | 0.15 | 0.05 |

### Value

The fair value comes from time-adjusted RCN comparables in `offer-model.ts`.
The asking price is reduced by a 15% negotiation margin when at least three
RCN comps support the estimate. A listing-only fallback uses 5% instead, so
the asking-price wedge is not counted twice.

`discount = 1 - asking * (1 - margin) / fair`

`value_score = 50 + 50 * tanh(discount / 0.15)`

### Transit

Tram, railway station, bus and city centre use distance bands. A railway line
within 200 m lowers the transit score and adds `rail_noise`.

### Green

Park distance, forest distance plus forest share within 500 m, and lake or
river distance plus water share within 1 km. Forest and water shares are
sampled on a 5x5 grid from OSM polygons.

### Property

Flats: floor, elevator, build year, condition, material, heating, ownership,
balcony, terrace, garden, parking, garage, basement, rooms.

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
- `discount >= 20%`

Top 5% is computed per region and segment. A listing is alerted at most once.

## Data and tables

- `listing_scores`: one row per listing per score version, with components,
  reasons, amenities and flags.
- `listing_alerts`: one row per listing per day per channel, with a unique
  index that makes the job idempotent.
- `src/lib/scoring/config.ts`: versioned policy constants.
- `src/lib/scoring/alert-score.ts`: pure scoring engine.
- `src/lib/scoring/run.ts`: batch run, ranking and alert creation.
- `server/tasks/score-listings.ts`: daily task at 06:30.
- `src/routes/api/alerts.ts`: shared alert feed.
- `src/routes/alerts.tsx`: shared in-app list.

## Validation

`bun run validate:scoring` checks 26 properties:

- discount, tram, park, forest and water are monotonic
- rail noise lowers transit and is flagged
- station at the doorstep is penalized against 900 m
- media, WZ and MPZP increase plot score
- flood risk lowers plot score and is flagged
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
