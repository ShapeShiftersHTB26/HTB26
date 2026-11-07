---
name: dev-transforms
description: Implement or debug Backtrace transforms and evaluation — source ingest, the declarative ops interpreter, agent_map/agent_reduce, record lineage and trace. Use when working in api/app/executor.py, api/app/transforms/ or api/app/trace.py (stages 2–4).
---

# Transforms, evaluation, trace

The contract and the op semantics are in [docs/SPEC.md](../../../docs/SPEC.md) (Transforms, Evaluate and trace).

**One rule matters above all: every output row has `_src`, the rids of its input rows.** The executor turns `_src` into `DERIVED_FROM` edges, and if `_src` is missing there's no trace.

## Build order
1. **source** (`transforms/source.py`, S2): use `pd.read_csv(path, names=columns, header=None, chunksize=200_000)`, apply the filter expression to each chunk and concatenate. Infer the schema from dtypes: numbers → `measure`, dates → `time`, everything else → `dimension`. The agent refines the roles later. In S2, `ingest` also writes the records, so source views have data from the start.
2. **ops** (`transforms/ops.py`, S3): about 40 lines.
   - Start with `df['_src'] = df['_rid'].map(lambda r: [r])`.
   - filter: `df[ev(where, df)]`
   - derive: `df[col] = ev(expr, df)`
   - aggregate: `groupby(by).agg(...)`, with `_src` collected via `lambda s: sum(s, [])`
   - sort and limit are plain pandas.
   - `ev(expr, df) = eval(expr, {"pd": pd, "np": np}, {c: df[c] for c in df.columns})`. *HACK: this is local only.*
   - At the end, project to the shape's columns plus `_src`.
3. **executor** (`executor.py`, S3): `evaluate`, exactly as in the spec. Convert numpy types to plain Python before writing to Memgraph, and dates to ISO strings.
4. **trace** (`trace.py`, S3): breadth-first over `DERIVED_FROM`, one level at a time, returning a count plus a sample for each level.
5. **agentic** (`transforms/agentic.py`, S4): **load the `claude-api` skill first.**
   - Use one forced tool whose `input_schema` comes from the output shape.
   - map: batches of 50 rows, merged back by `_rid`.
   - reduce: up to 200 rows; keep only cited rids that really were in the input.
   - Cache each response by `sha256(model + prompt + payload)` in `/data/cache`.
6. **join** (S4): `{"op": "join", "with": "<view>", "on": [...], "how": "left|inner"}`, with `_src` set to the concatenation of both sides' rids.

Dry runs on preview rows are deferred to S5.

## Checking your work
- After evaluating, `MATCH (r:Record)-[:IN]->(:Instance {id:$i}) RETURN count(r)`, and spot-check one record's `DERIVED_FROM` count in Lab.
- An aggregate row's lineage count should equal its `count` metric.
- Keep error messages short and readable, because the agent sees them, e.g. `"column 'postcode_district' not in input"`.
