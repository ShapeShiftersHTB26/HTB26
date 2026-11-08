# Dev spec v2 — Backtrace POC

Read [BRIEF.md](../BRIEF.md) first. This file is the build spec.
**Bias:** do the simplest thing that makes the demo work. Leave a `# TODO` on edge cases and move on. If the spec is wrong, fix it in the same change.

## The demo we're building towards
1. In Claude Code (run from `agent/`): *"Average annual price of flats in Reading by postcode district — use the Price Paid data."*
2. Claude proposes a view `flat_prices_by_district`:
   - columns `[postcode_district, year, avg_price (GBP)]`
   - grain "one row per district × year"
   - scope "Reading, flats"
   - preview rows

   You comment "add number of sales", a sibling version appears, and you approve it.
3. **Visual:** Claude proposes an HTML line chart, rendered over the preview rows. You approve it.
4. **Upstream:** Claude proposes an aggregate transform that reads a new view `reading_flat_sales` (approve), then a filter + derive transform that reads the source `ppd` (approve).
5. **Downstream:** "which district peaked highest?" produces a new view `peak_district` (one record) computed from `flat_prices_by_district`, with its own visual.
6. **Evaluate:** the visuals now render real data. Click a point to trace it: avg_price → the 37 sales behind it → the raw Price Paid rows.
7. Stretch: an `agent_reduce` view of "3 notable trends", shown as cards and traced to the cited rows.

## Repo layout
```
docker-compose.yml
api/                  Python 3.12, FastAPI + MCP (Dockerfile, requirements.txt)
  app/main.py         FastAPI app; exposes the ops registry as MCP (/mcp) and REST (/api/op/<name>), plus /api/chat
  app/chat.py         web chat: runs the app agent (Claude Agent SDK, cwd agent/) and streams it as SSE
  app/registry.py     @operation decorator + registry list
  app/ops.py          ALL operations, as plain typed functions (single source of truth)
  app/graph.py        Memgraph driver + Cypher helpers
  app/executor.py     evaluate + record writing                       (stage 3)
  app/transforms/     source.py, ops.py, agentic.py                    (stages 2–4)
  app/trace.py                                                         (stage 3)
web/                  Vite + React + TS, react-flow
agent/                the APP agent: run Claude Code from here
  CLAUDE.md, .mcp.json, .claude/skills/   (app-usage skills)
.claude/skills/       DEV skills (dev-*)
data/raw/  data/cache/   (gitignored, mounted into api at /data)
scripts/              reset.py, seed.py, smoke.py
```

## Services (`docker-compose.yml`)
| Service | Image / build | Port | Notes |
|---|---|---|---|
| `memgraph` | `memgraph/memgraph` | 7687 | volume `mg_data:/var/lib/memgraph` |
| `lab` | `memgraph/lab` | 3000 | `QUICK_CONNECT_MG_HOST=memgraph` |
| `api` | `./api` | 8000 | uvicorn `--reload`; mounts `./api/app`, `./data:/data` and `./agent:/srv/agent` (read-only, for the web chat); env `MEMGRAPH_URI`, `ANTHROPIC_API_KEY`, `BACKTRACE_MODEL` (agentic transforms) and `BACKTRACE_AGENT_MODEL` (web chat + research threads), both default `claude-haiku-5-5` |
| `web` | `./web` | 5173 | Vite dev server; proxies `/api` → `api:8000` |

The app agent is Claude Code on the host, launched in `agent/`. `agent/.mcp.json` points at `http://localhost:8000/mcp/` (streamable HTTP).

The same agent also runs inside the api for the web chat. `POST /api/chat {message, session_id?, view_id?, intent_id?}` runs it with the Claude Agent SDK:
- **Setup:** `cwd=/srv/agent`, so it loads `agent/CLAUDE.md` and the app skills; its only tools are `Skill` and the backtrace MCP tools.
- **Stream:** it sends SSE events (`session`, `text`, `tool`, `tool_error`, `note`, `done`, `error`). Pass `session_id` back to continue a conversation.
- **Stop:** closing the request (Stop) cancels the run.

MCP tools run in the threadpool, so a slow op doesn't block the event loop.

## Graph model
| Node | Key props |
|---|---|
| `View` | `id, name, kind (source\|derived), question?, auto_accept, created_at` |
| `SchemaVersion` | `id, view_id, schema (json), grain, scope (json list of strings), preview (json rows), rationale, author (agent\|user), parent_id?, proposed_with?, status (pending\|approved\|discarded), counter?, decided_by?, created_at` |
| `Transform` | `id, view_id (output), kind (source\|ops\|agent_map\|agent_reduce), spec (json), reads (json list of view ids), rationale, author, parent_id?, status, counter?, decided_by?, created_at` |
| `Visual` | `id, view_id, html, rationale, author, parent_id?, status, counter?, decided_by?, created_at` |
| `Comment` | `id, target_id, text, author, created_at` |
| `Instance` | `id, view_id, created_at, row_count, invalid_count, model?` |
| *(rows)* | **not in Memgraph.** Rows and record lineage live in Postgres (see [BRIEF-data-plane.md](BRIEF-data-plane.md)): `raw.src_<view>` (append-only) and `derived.inst_<id>` with `_rid`, `_n`, `_src text[]`. `Instance.storage` names the table. |
| `Counter` | `name='global', value` |

Edges:
```
(SchemaVersion)-[:VERSION_OF]->(View)   (Transform)-[:COMPUTES]->(View)   (Visual)-[:RENDERS]->(View)
(Transform)-[:READS]->(View)            (any proposal)-[:REVISES]->(parent proposal)
(Comment)-[:ON]->(proposal)
(Instance)-[:OF]->(View)  (Instance)-[:USED_SCHEMA|USED_TRANSFORM]->(...)  (Instance)-[:FROM]->(Instance)
(record lineage: Postgres `_src` arrays, resolved through meta.tables)
```
**Proposals** are `SchemaVersion`, `Transform` and `Visual`. They share one set of mechanics:
- **Immutable.** Only `status`, `counter` and `decided_by` are set, and only once, when the proposal is decided.
- **Approve:** in one transaction, increment `Counter.value` and set `status='approved'` and `counter`. **Head** = the approved proposal of that type for that view with the highest `counter`. One head shape, one head transform and one head visual per view. *(TODO: several visuals per view.)*
- Approving a transform also approves the pending `SchemaVersion`s it proposed (`proposed_with = transform.id`).
- **Revise** = a new proposal with `parent_id` set and a `REVISES` edge. Siblings share a parent.

Navigation:
- **Upstream** of a view = the views its head transform `READS`.
- **Downstream** = the views whose head transform reads it.
- The canvas draws pending transforms' `READS` as dashed edges.
- **Frontier** of a view = the views upstream of it (including itself) that have no approved transform. Source views are never in the frontier.

Indexes: `:Record(rid)`, plus `:View(id)`, `:SchemaVersion(id)`, `:Transform(id)`, `:Visual(id)` and `:Instance(id)`.

## Intents (the request layer)
- **`Intent`** `{id, text, anchors (json view ids), mode (auto|guided), status (open|answered), parent_id?, result_id?, result_kind (view|visual), summary?, author, created_at}`.
- **Edges:** `(Intent)-[:ANCHORED_ON]->(View)` and `(Intent)-[:FOLLOWS]->(Intent)`.
- **Membership:** every proposal made while serving an intent carries `intent_id`, and so does every view created under it. Membership is derived from that, never maintained separately.
- **Inputs** of an intent are its anchors plus the views its transforms read that aren't members.
- **Ops:** `start_intent`, `get_intent` (the ordered story of steps), `resolve_intent`. `get_graph.intents` gives summaries (members, inputs, steps, `result_current`).
- **Research threads (chat):** a thread is a root Intent plus its follow-ups (`parent_id`), with `(Message {role, text, kind, datasets?, suggestions?})-[:IN_THREAD]->(Intent)`.
  - **UI and runner ops (REST only):** `ask` (posts a user message and queues the agent; creates the thread when there's no `intent_id`), `get_thread` (messages, proposals, dataset cards and results in order, plus the stage), `next_turn` and `finish_turn`.
  - **Agent ops (MCP):** `say` (dataset cards and quick replies), `list_datasets` (curated catalog in `api/app/datasets.json`), `ingest_dataset` (loads a catalog dataset as a source, reusing one with the same filter).
  - **Worker:** `api/app/worker.py`, inside the api, serves queued threads one turn at a time.
    - It uses `chat.events`: the same Agent SDK agent as the web chat, on `BACKTRACE_AGENT_MODEL` (default Haiku).
    - Each thread resumes its own session (`Intent.session_id`).
    - `Intent.agent_status` is idle, queued, working or error; `Intent.agent_activity` is the current tool call.
    - **Fallback:** with `BACKTRACE_THREAD_WORKER=off`, `scripts/runner.py` serves threads with the host `claude` CLI instead.
  - **Canvas:** `get_thread.canvas` gives:
    - the thread's tables, with the head plus pending shape versions (the UI draws a pending sibling as a diff), pending transforms, visuals, the latest instance and the answer;
    - upstream lineage through head transforms;
    - `Note` nodes (`note` op, `about` = a view);
    - the open dataset choice;
    - the latest focus.

    Messages carry `focus` (view ids), from the user's selected node or from the agent's `say(focus=…)`.
  - **Workspace:** a thread is a workspace that can hold several questions. Each one is an intent with `parent_id`; `canvas.questions` gives each question's tables and its answer.
    - **The canvas is laid out in bands:** questions on top, computed tables in the middle, sources on the data shelf at the bottom.
    - **Tables are compact** unless they're focused, have something pending, or are the answer to the selected question.
    - **Selecting a question** highlights its chain; tables carry a coloured dot for each question that uses them.
    - **The left panel** has two tabs: Questions (with **+ Question**, sent as "New question: …") and Tables (with **+ Data**).
- **Notebook (the receipt)** (`api/app/notebook.py`):
  - `get_notebook(view_id)` gives the steps that produced the view's latest instance, following its actual inputs, sources first. Each cell has its code, rationale, lineage level, rows and fingerprint; ops are rendered as plain pandas, with `_src=('_rid', rids)` keeping row lineage through aggregations.
  - `preview_transform(view_id, code)` runs edited code without storing anything.
  - `export_notebook(view_id, format=py|ipynb)` writes a pandas script that rebuilds the result from the source CSVs. Agentic steps are embedded as their stored output.
  - **The escape hatch** is transform kind `python`, with spec `{code}`. The inputs are variables named after the input views (with `_rid`), and the code assigns its result to `df`. Row lineage is kept only if the output keeps `_rid` or `_src`; otherwise it's coarse. Verify re-runs it like ops.
  - Open a notebook from a table's ⟨/⟩ button, or with `#/t/<thread>/nb/<view>`.
- **Big CSVs:** `scripts/load_big_csv.py` is a one-off loader outside the api (see its docstring).
  1. It scans the whole file to infer column types.
  2. It streams the rows into Postgres in chunks.
  3. It hashes the stored rows the way `verify` does, then writes the usual manifests.
  - The flow is described in [BRIEF-flow.md](BRIEF-flow.md).
- **`result_current`** follows the result visual's revision tree, so approving a revision updates the outcome automatically.
- **Mode:** `auto` means the agent approves its own steps and the user inspects the path afterwards. `guided` is step-by-step approval. The default is auto when anchored, guided for a fresh question.
- **Canvas lenses:**
  - **Outcomes** (default): each intent collapses into inputs → intent → result; click an intent to expand its path.
  - **Detail:** the full graph.

## Shape format
`schema` is JSON Schema for **one row**, plus annotations. It travels together with `grain`, `scope` and `preview`:
```json
{"schema": {"type": "object",
   "properties": {
     "postcode_district": {"type": "string",  "x-role": "dimension", "description": "e.g. RG1"},
     "year":              {"type": "integer", "x-role": "time"},
     "avg_price":         {"type": "number",  "x-role": "measure", "x-unit": "GBP"},
     "n_sales":           {"type": "integer", "x-role": "measure"}},
   "required": ["postcode_district", "year", "avg_price"]},
 "grain": "one row per postcode district per year",
 "scope": ["Reading", "flats only", "all available years"],
 "preview": [{"postcode_district": "RG1", "year": 2023, "avg_price": 241000, "n_sales": 52}]}
```
- Roles: `id`, `dimension`, `time`, `measure`, `geo_lat`, `geo_lon`, `text`.
- Dates are ISO strings.
- From stage 3, rows are validated with `jsonschema`. Invalid rows are dropped and counted.

## Visuals
- `html` is a full HTML document written by the agent. The web app renders it in `<iframe sandbox="allow-scripts" srcdoc=…>`. Before the agent's HTML it injects:
  ```html
  <script>window.BACKTRACE = {schema, rows, mode: "preview" | "instance", view: {id, name}};
  window.backtraceSelect = rid => parent.postMessage({type: "select", rid}, "*");</script>
  ```
- The visual reads `window.BACKTRACE.rows` and renders anything it likes. Calling `backtraceSelect(row._rid)` on click opens the trace drawer. Preview rows have no `_rid`, so the call does nothing there.
- Libraries come from a CDN (e.g. `cdn.jsdelivr.net/npm/vega-embed@6`), or vanilla SVG and Canvas. *(TODO: vendor them for offline demos.)*
- If a view has no visual, the UI falls back to a plain table.
- **Several visuals per view:** each revision tree (a root proposal plus its revisions) is one visual with its own head; `get_view.visual_heads` lists them all.
- **`uses`:** a visual may also use other views, e.g. a reference view of district locations. Their rows are injected as `window.BACKTRACE.views[<name>] = {view_id, schema, rows, mode}` and the HTML joins them on a key.
- **Map tiles:** use Esri's Canvas `World_Light_Gray_Base` tiles (no key needed). OSM's tile servers block this traffic, and CARTO now requires an API key.

## Transforms
**Contract:** `run(inputs: dict[view_name, DataFrame], spec) -> DataFrame`. Each input frame has a `_rid` column. The output has the shape's columns plus `_src` (a list of input rids). Transforms never touch the graph.
- **source** `{path, columns?, filter?, parse_dates?, limit?}`: read a CSV in chunks and apply the filter expression. No `_src`.
- **ops** `{ops: [...]}`: exactly one input until join lands.
  - `{"op": "filter", "where": "<expr>"}`
  - `{"op": "derive", "column": "<name>", "expr": "<expr>"}`
  - `{"op": "aggregate", "by": [cols], "metrics": {"<out>": ["<col>", "mean|median|sum|count|min|max"]}}`
  - `{"op": "sort", "by": [cols], "desc": bool}`, `{"op": "limit", "n": int}`
  - Later: `join`.
  - Expressions are Python, with the columns as pandas Series and `pd` and `np` available. *(HACK: `eval`, local only.)*
  - Lineage: each row starts with `_src=[rid]`. Filter, derive, sort and limit keep it. Aggregate concatenates the lists in each group.
- **agent_map** `{prompt, batch_size: 50}` and **agent_reduce** `{prompt, max_rows: 200}`: the api calls Claude with a forced tool whose input schema is built from the output shape. Map rows are keyed by `_rid`; reduce rows carry cited `_src`. Calls are cached in `/data/cache`. *(Stage 4.)*

## Evaluate and trace (stage 3)
`evaluate(view_id, inputs?)`:
1. Get the head shape and head transform.
2. For each input view, use the given instance, otherwise the **latest instance**, otherwise evaluate it recursively.
3. Load the input records, run the transform and validate the rows.
4. Write the `Instance` with its `USED_*` and `FROM` edges, then the `Record`s in `UNWIND` batches of 1000. Record rids are `<instance_id>:<n>`. Write `DERIVED_FROM` edges from `_src`.

`trace(rid)`: walk `DERIVED_FROM` breadth-first, one level at a time. Group each level by instance and return `{view, transform kind + spec, count, sample}`. Stop at source records.

## Operations (one registry → MCP tools + REST)
Each operation is a typed function in `ops.py`, registered with `@operation`. Its docstring becomes the tool description. `main.py` exposes every operation both as an MCP tool and as `POST /api/op/<name>` (the JSON body is the kwargs).

| Op | Stage | Args | Returns |
|---|---|---|---|
| `ping` | 0 | – | `{ok, memgraph}` |
| `get_graph` | 0 | – | all views with head and pending proposals of each type, plus their edges (the UI polls this) |
| `get_view` | 1 | `view_id` | every proposal of every type (as trees), comments, upstream and downstream views, instances |
| `propose_schema` | 1 | `view_id?, name?, question?, schema, grain, scope, preview, rationale, parent_id?, author` | a `SchemaVersion` (creates the `View` if there's no `view_id`) |
| `comment` | 1 | `target_id, text, author` | a `Comment` |
| `decide` | 1 | `target_id, decision (approve\|discard), by (user\|auto)` | the new status and counter |
| `propose_visual` | 2 | `view_id, html, rationale, parent_id?, author` | a `Visual` |
| `ingest` | 2 | `path, name, columns?, filter?, parse_dates?, limit?` | a source view with an inferred schema and a source transform (both auto-approved), evaluated |
| `propose_transform` | 2 | `view_id, kind, spec, reads, new_inputs [{name, schema, grain, scope, preview}], rationale, parent_id?, author` | a `Transform` plus any new input views and their schemas |
| `get_frontier` | 2 | `view_id` | unresolved views upstream |
| `get_records` | 2 | `view_id \| instance_id, where?, limit=50, offset=0` | rows plus instance metadata |
| `evaluate` | 3 | `view_id, inputs?` | `{instance_id, row_count, invalid_count}` |
| `trace` | 3 | `rid` | levels |
| `append_batch` | DP2 | `view_id, path` | new raw batch plus a new snapshot of the source view (with hashes) |
| `verify` | DP2 | `instance_id, recompute=True` | hash-tree verification report |
| `market_draft` | PM | `view_id, where?, column?, op?, threshold?, resolution_time?, initial_price_cents?, question?` | defaults + checks for a data-settled market (see below) |
| `create_market` *(REST only)* | PM | the same plus `intent_id?` | opens the market on the prediction-market backend |
| `market_status`, `settle_market` *(REST only)* | PM | `market_id` | today's value / settles a market past its end date |
| `set_auto_accept` | 5 | `view_id, on` | – |
| `wait_for_decision` | 5 | `target_ids, timeout_s ≤ 50` | statuses and new comments |

## Markets settled by data (`api/app/markets.py`)
A computed view becomes a YES/NO prediction market on one of its numbers: *"will `column` for the row `where` be `op` `threshold` at `resolution_time`?"*. Research tables have **Make it a market** (or **Ask the market** on the next-period row).
- **Checks** (`market_draft`, re-run on every edit):
  - **Blocking:** every step from the sources is approved and is `ops` (an `agent_map`/`agent_reduce` step blocks it); the selector picks at most one row; the column is numeric; the end date is ≥ 2 min away; the table has ≤ 5000 rows.
  - **Warnings:** the row doesn't exist yet (void if it still doesn't by then); today's data already decides it; the line is far outside the data; the period isn't over by the end date.
  - **Defaults:** the next period (years, `YYYY-MM`); a line rounded from the latest value; an end date one month after the period; and a starting chance from past period-on-period changes.
- **Pinning:** the market stores its rule in the prediction-market backend (`markets.resolution` jsonb): view, where, column, op, threshold, the formula hash, and `pins` (the shape and transform ids of every view upstream). Revising the view later doesn't change what the market settles on.
- **Settlement:** `settle_market` is permissionless; the api also runs it every 20 s for due markets.
  1. Evaluate the pinned chain on the latest source snapshots, reusing an instance computed from the same inputs.
  2. Check the formula hash and `verify(recompute=True)`.
  3. Compare and post the outcome. Missing row → void.
  4. Post the evidence (`resolution.settlement`: value, row, instance hash, source files) to `POST /markets/{id}/resolve` with the admin key (`PM_API_URL`, `PM_ADMIN_KEY`).
- **Display:** the Predictions tab shows a "Settled by data" card: the rule, today's value, history against the line, the evidence and a link back to the research thread.

## Web (one page, polls `get_graph` every 2s)
- **Canvas** (react-flow, laid out top to bottom with dagre): one graph of views, data and visuals.
  - **View nodes** carry badges: source, draft, N pending, empty.
  - **View → view edges** are transforms, labelled with their kind (agentic ones in the accent colour). Pending transforms are dashed.
  - **Data nodes** hang off their view: the latest instance's row count, an "agentic" badge if a model produced it, and "+N older".
  - **Visual nodes** hang off their view, labelled map or chart (from the HTML), dashed while pending.
  - **`uses` edges** are dashed and run from a reference view to the visuals that use it.
  - Clicking a node opens that view's panel on the matching tab.
  - *TODO:* collapse edges that span many ranks once the graph grows.
- **Side panel** for the selected view:
  - **Shape tab:** proposal cards, with siblings side by side and the approved chain highlighted. Pending cards have Approve, Discard and Comment buttons. Each card shows columns (with role and unit), grain, scope, a preview table and the rationale.
  - **Visual tab:** the same card layout. Each card has an **Open visual** button; visuals are never embedded in the sidebar.
  - **Transform tab:** the same card layout, with the ops written out in plain language.
  - **Data tab** (stage 3): instance picker, the visual over the real rows (or a table), and an Evaluate button.
- **Visual windows:** each visual opens in its own floating window: draggable by its header, resizable from the corner, several open at once, clicked to bring to the front. Windows open from a visual node on the canvas, a card's Open button, the Data tab's visual buttons, or an intent's Open result. A window re-renders when its view gets a new instance.
- **Trace drawer** (stage 3): opened by a `select` postMessage or a click on a table row.
- **Chat panel** (bottom left, minimisable): talk to the app agent through `/api/chat`.
  - **Display:** its replies and a one-line label per tool call.
  - **Context:** the selected view or intent is passed along as context.
  - **Stop:** the Stop button aborts the run.
  - **Persistence:** the conversation (session id + messages) is kept in localStorage.
  - The canvas updates from the graph as usual.

## Stages (each ends with `docker compose up` and the demo path working so far)
- [x] **S0 Skeleton:** all four services up. `ping` and `get_graph` work over REST and MCP. Claude Code in `agent/` sees the tools. The web app shows an empty canvas, polling.
- [x] **S1 Question → view:** `propose_schema`, `comment`, `decide` and `get_view`, with head and counter logic. The UI shows views and shape cards with Approve, Discard, Comment and a preview table. The `question-to-shape` skill works end to end.
- [x] **S2 Advance:**
  - **visual:** `propose_visual` plus the iframe on preview rows
  - **upstream:** `ingest` and `propose_transform` (stored, not run), `get_frontier`, dashed and solid edges
  - **downstream:** a new view whose transform reads an existing one
  - Skills: `propose-visual`, `reverse-step`, `derive-downstream`
- [x] **S3 Evaluate:** ops executor, records with lineage, the Data tab with visuals over real rows, `trace` and the drawer. **This is the minimum demo.**
- [x] **S4 Agentic + join:** *(join op still TODO)* `agent_map` and `agent_reduce` with caching; the `join` op.
- [ ] **S5 Polish:** dry run on preview rows, auto-accept, `wait_for_decision`, stale flags, demo rehearsal and a graph snapshot.

## Iteration rules
- No auth, and no tests beyond `scripts/smoke.py` running the demo path so far.
- `scripts/reset.py --all` wipes the graph and the data plane; `scripts/reset.py <prefix>` removes only matching views. `scripts/seed.py` ingests the seed data.
- Hardcode before you configure, and mark it `# HACK`.
- Price Paid CSVs have no header. Use these columns: `transaction_id, price, date, postcode, property_type, new_build, tenure, paon, saon, street, locality, town, district, county, ppd_category, record_status`. Flats are `property_type == 'F'`, and Reading is `district == 'READING'`.
