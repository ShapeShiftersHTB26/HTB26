# Next stage: data plane (sources, recipes, snapshots, hashes)

*Status: agreed direction. **Phases 1–2 done:**
- **Phase 1:** data plane on the remote cluster, records migrated.
- **Phase 2:** recipes, batches, snapshots, hashes and `verify`; existing instances backfilled, and every chain verifies. Details go into [SPEC.md](SPEC.md) as each phase lands.*

## Why
Holding raw rows in Memgraph doesn't scale. We split the system into:
- **Memgraph, the control plane:** sources, recipes, views, transforms, visuals, intents, proposals, snapshot and instance **manifests**, hashes, and instance-level lineage (`Instance -FROM-> Instance`). It stays small.
- **Postgres, the data plane:** all **rows**, raw and derived, plus **record-level lineage**. It runs on a remote cluster, reached through `PG_DSN` in `.env`. Memgraph no longer holds Record nodes.

The UI and the agent see the same operations as before (`get_records`, `trace`, `evaluate`). Only the storage behind them changes.

## Postgres layout
| Schema | Contents | Rules |
|---|---|---|
| `raw` | one landing table per source view; every row has `_rid`, `_batch_id`, `_n` and `_loaded_at` | **append-only**: a trigger rejects UPDATE and DELETE |
| `derived` | one table per derived instance, `inst_<id>`, with `_rid`, `_n`, `_src text[]` (lineage) and the shape's columns | written once |
| `meta` | `tables`: maps each rid prefix (an instance or batch id) to its table, so `trace` can resolve any rid | – |

A rid stays `<instance_or_batch_id>:<n>`, so the lineage format is unchanged.

## Concepts
- **DataSource:** a connection type (`file`, `postgres`, `http`) plus a reference to its credentials (an env or secret name, never the credential itself).
- **Recipe:** the source view's versioned transform. It's a file path plus parsing rules, a SQL query, or an API request template plus mapping. Running it **appends a batch** to `raw`.
- **Snapshot:** the source view's instance. It holds the recipe version, the batch set, the row count and the **root hash**. New data appends a new batch, and the new snapshot covers the old batches as well.
- **Corrections** (e.g. Price Paid's change and delete records) are a visible deterministic transform, "latest status per key", never mutation.

## Engines (both available)
- **`sql`:** ops compile to SQL and run inside Postgres, so big data never leaves the database. Lineage is `array_agg(_rid)`. Expressions are SQL, e.g. `split_part(postcode, ' ', 1)`.
- **`python`:** the current pandas interpreter (expressions are pandas), plus all agentic steps. It reads its input from Postgres and writes its output to `derived`.

## Hashes (truthful, covering the whole chain)
- **Data root:** a Merkle root over an instance's rows, in canonical serialisation (fixed float rounding, ISO dates, sorted keys), ordered by `_rid`, in chunks of about 10k rows. It's computed by the executor while streaming rows from Postgres.
- **Formula hash:** covers the shape, the transform or recipe spec, the engine and its version, and the input formula hashes.
- **Instance hash:** `H(formula hash, data root, sorted input instance hashes)`. It's recursive, so **the final operation's hash commits to the whole chain down to the source batches**. That's the one value a market needs.
- **Agentic steps** are hashed by their stored outputs. They can be replayed but not recomputed, and the verify report marks them.
- **`verify(instance_id)`** recomputes the chain from Postgres and compares, returning the hash tree for the "under the hood" view.
- **Scope:** truthfulness of the computation, not authenticity of the provider. The two aren't the same thing, and authenticity is explicitly out of scope.

## As built (phase 2)
- **Source views:**
  - The head transform (kind `source`, spec type `file`) is the **recipe**.
  - `ingest` creates the recipe and appends batch 1.
  - `append_batch(view, path)` runs the recipe on another file, adds a `Batch` node (path, file sha256, data root, hash) whose rows are appended to `raw.src_<view>`, and publishes a new **snapshot** instance: `batches` = the previous snapshot's batches plus the new one, registered in `meta.tables` as kind `snapshot`.
- **Every instance stores `formula_hash`, `data_root`, `hash` and `engine`,** computed by reading the rows back from Postgres. The rules (canonical rows, chunk size, how formulas are hashed, run parameters left out) are in `api/app/hashing.py`.
- **`verify(instance_id, recompute)`** returns a tree. For each node it reports data root, formula, hash, and a re-run of ops steps from stored inputs. For each batch it reports rows, hash and the source file. Agentic steps are verified against their stored output.
- **UI:**
  - The Data tab shows the instance hash and a Verify button with the tree.
  - The intent panel shows the **result hash**, the one value a market commits to.
  - The trace drawer shows each level's hash.
- **One-offs:** `python -m app.backfill_hashes` (already run).

## Phases
1. **Data plane:** Postgres connection, the `raw`, `derived` and `meta` schemas, the append-only trigger, all instance rows and lineage in Postgres, `get_records` and `trace` reading from Postgres, and a migration of the existing Memgraph records.
2. **Recipes, snapshots and hashes:** a file recipe (`COPY` into `raw`), batches and multi-batch snapshots, Merkle roots, formula and instance hashes, `verify`, and hashes shown in the UI.
3. **SQL engine:** ops compiled to SQL with `array_agg` lineage; the app skills learn both engines.
4. **More recipes:** Postgres-query and HTTP recipes, with raw API responses stored as jsonb.
