# Next stage (DRAFT): prediction markets on verifiable views

*Status: draft for discussion. Nothing here is built yet. Refine it before it goes into [SPEC.md](SPEC.md).*

## Idea
Let people forecast values produced by Backtrace views, e.g. *"Will the 2026 average flat price in RG1 be above £237,944, its 2025 value?"* Each market is bound to a **frozen chain** of views and transforms down to the source data. It settles **deterministically** when new source data arrives, and anyone can verify the settlement through **hierarchical hashes**.

## Market model
- **Target:** a view, a row selector and a field, e.g. `flat_prices_by_district`, the row `{postcode_district: RG1, year: 2026}`, field `avg_price`.
- **Condition:** above or below a threshold:
  - **absolute**, e.g. £250k; or
  - **relative to a baseline**: the current value, taken from a specific instance. +0% means "will it increase"; ±x% gives a band.
- **Pinned formula:** the exact shape and transform versions of every view in the chain, down to the sources. Markets evaluate against these frozen versions, never against the current head.
- **Resolution rule:** which source snapshot settles it, e.g. "the first Price Paid file published after 31 Jan 2027". If the target row doesn't exist at resolution (for example no sales), the market is void.
- **States:** open → closed → resolved (yes or no) or void, plus positions and a price history.

## Hierarchical hashes (Merkle DAG)
- **Formula hash:** `H(view) = H(canonical shape, transform kind + spec, engine version, sorted H(inputs))`. A source's formula hash covers its spec. Any upstream change gives a new hash. A market commits to it when it's created.
- **Data hash:** `H(instance) = H(formula hash, Merkle root of records, H(input instances))`. A source instance includes the **sha256 of the raw file**, so anyone can re-download it and check.
- **Proofs:**
  - **Inclusion proof** of the resolving row, from the records' Merkle root.
  - **Derivation proof:** the record lineage showing which hashed source rows produced the value.
- **Determinism requirements:** canonical JSON, fixed rounding, a defined row order, and a pinned interpreter version. Floating-point aggregation order needs care.

## Agentic steps
LLM transforms aren't reproducible, so:
- Any step whose input includes **future data must be deterministic** (ops only).
- An agentic step is allowed only if it's **frozen**: its output is captured and hashed when the market is created, like an oracle attestation. A district-locations lookup qualifies; an agent judging whether prices rose does not.
- The audit view marks frozen agentic inputs clearly.

## Mechanics
- **Play money or points only.** Real-money prediction markets are regulated (gambling, CFTC, FCA), so that's out of scope.
- **LMSR automated market maker:** no order book, the price is the implied probability, and it's small to implement.
- **Storage:** positions and trades on the graph, e.g. `(User)-[:HOLDS]->(Market)`.
- **Optional:** Brier scores for forecasters after resolution.

## Resolution flow
1. A new source snapshot is ingested, and its file hash is recorded.
2. The **pinned** chain is evaluated over it, producing a resolving instance with its hashes.
3. Read the selected cell, compare it with the threshold, and settle the positions.
4. Publish a **proof bundle**: formula hash, source file hash, instance hashes, the inclusion proof and the value.
5. **Verify:** a button and an op that recompute everything and confirm the hashes match.
6. *Stretch:* anchor the formula hash externally when the market is created (a public timestamping service or a chain).

## User experience
- **Create from the data:** click a number in any result visual or table, choose **Create market**, and get a pre-filled question with a threshold slider (absolute or ±%) and a resolution rule.
- **Create from plain language:** the agent drafts the market as an intent proposal ("make a market on whether Caversham houses rise next year"). Drafting can be agentic; resolution never is.
- **Canvas:** market nodes hang off result views in the Outcomes lens and show the live probability.
- **Market page:**
  - the question, the probability chart and trading;
  - "lift the hood" as the **audit trail**: the frozen chain, its hashes, the baseline instance and Verify;
  - a warning when the market's pinned formula is no longer the current definition. Exploring and revising views keeps working; open markets stay pinned.

## Demo: a backtest
With historical data: ingest 2024 as the "present", create markets on 2025 values, trade, then "publish" `pp-2025.csv`, resolve, and show the proof plus Verify. This needs `pp-2024.csv`, and ideally 2023.

## Phases
1. **Hashes:** formula and data hashes computed at evaluation, shown in the UI, plus a `verify` op.
2. **Pinned evaluation:** `evaluate(view, pinned_versions)` and a check that a chain is deterministic, rejecting or freezing agentic steps.
3. **Markets:** a Market node, creation from a cell, LMSR trading with points, a probability chart.
4. **Resolution:** new snapshot → pinned evaluation → settlement → proof bundle and Verify.
5. **Agent:** drafting markets from plain language and writing resolution reports.

## Open questions
1. Play money or points for the demo: confirmed?
2. Source data for the backtest: `pp-2024.csv`, and 2023?
3. Agentic steps in market chains: freeze them, or forbid them in the first version?
4. Who creates markets: users from the UI, the agent from plain language, or both?
5. Public anchoring of the formula hash: part of the pitch, or is local Verify enough?
6. How to handle data revisions: Price Paid publishes changes and deletions (`record_status` C/D), so is the resolution snapshot fixed by date or by file hash?
7. What counts as "the yearly average": the mean as in today's views, or the median, which is more robust to the £1m+ outliers?
