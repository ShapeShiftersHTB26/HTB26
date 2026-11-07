# Next stage (DRAFT): prediction markets on verifiable views

*Status: draft for discussion. Refine it before it goes into [SPEC.md](SPEC.md).*

**Already built (by MIDAV0), in [`prediction-market/`](../prediction-market/README.md):** binary YES/NO markets on a local Solana validator.
- **Anchor program:** mUSDC (mock USDC) collateral, minting and merging YES+NO sets, admin resolution, redemption (a void market pays 0.5).
- **Order books:** OpenBook v2 YES and NO books per market.
- **Backend:** Rust, axum and Postgres, with a market-making bot.
- **Frontend:** React.

Its plan leaves resolution to an admin ("an oracle is out of scope") and lists "markets created from data (Land Registry `pp-*.csv`)" as future work. **Backtrace's role is to be that data layer and the verifiable oracle**: markets defined on frozen view chains, settled from a deterministic evaluation, with hashes anchored on chain.

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

## Mechanics: reuse the on-chain market
- **Trading, collateral and redemption** come from `prediction-market/`: mUSDC test tokens on a local validator, so effectively play money. Real-money markets stay out of scope (regulation).
- **Integration points:**
  - **Create:** Backtrace's "Create market" calls the market backend's `POST /markets` with the question and `resolution_time`. It then stores the returned market id on a Backtrace `Market` node, next to the pinned chain and the formula hash.
  - **Anchor:** add a `spec_hash: [u8; 32]` (the formula hash plus target and threshold) to the Market account in `initialize_market`, and a `proof_hash` to `resolve_market`. That needs a small change to the Anchor program, to agree with MIDAV0. Once it's in, anyone can check on chain that the market settled on the formula it committed to.
  - **Resolve:** Backtrace evaluates the pinned chain, then calls `POST /markets/:id/resolve` with the outcome (yes, no or void) and the proof hash. Resolution still goes through the admin key, but its input is the deterministic proof bundle, not a judgement call.
- **Ports:** both UIs default to 5173, and both stacks use Postgres or Memgraph ports. Remap one stack, or run the market stack under a separate compose project with offset ports.
- *Fallback if the chain stack isn't available:* an in-graph LMSR market maker with points.

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
0. **Run both stacks side by side** (fix the port clash) and agree the integration contract with MIDAV0.
1. **Hashes:** formula and data hashes computed at evaluation, shown in the UI, plus a `verify` op.
2. **Pinned evaluation:** `evaluate(view, pinned_versions)` and a check that a chain is deterministic, rejecting or freezing agentic steps.
3. **Markets:** a Market node, creation from a cell via the market backend, and the market's live probability shown on the canvas and the market page (read from the order books).
4. **Resolution:** new snapshot → pinned evaluation → proof bundle → `resolve` through the market backend (with `proof_hash` on chain) → Verify.
5. **Agent:** drafting markets from plain language and writing resolution reports.

## Open questions
1. Mechanics: build on `prediction-market/` (on-chain, mUSDC). Agree with MIDAV0 on the `spec_hash` and `proof_hash` program change, and on the resolve endpoint accepting a proof.
2. Source data for the backtest: `pp-2024.csv`, and 2023?
3. Agentic steps in market chains: freeze them, or forbid them in the first version?
4. Who creates markets: users from the UI, the agent from plain language, or both?
5. Public anchoring of the formula hash: part of the pitch, or is local Verify enough?
6. How to handle data revisions: Price Paid publishes changes and deletions (`record_status` C/D), so is the resolution snapshot fixed by date or by file hash?
7. What counts as "the yearly average": the mean as in today's views, or the median, which is more robust to the £1m+ outliers?
