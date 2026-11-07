---
name: dev-api
description: Work on the Backtrace api service — Memgraph graph model, proposal mechanics (shape/transform/visual versions, approve, head), Cypher helpers, and the single ops registry exposed as both MCP tools and REST. Use when adding or changing an op, touching api/app/ops.py, registry.py, graph.py or main.py, or debugging MCP/REST.
---

# api: graph + operations

The graph model and the op table are in [docs/SPEC.md](../../../docs/SPEC.md). Stick to them.

## Adding or changing an op
1. Write a plain typed function in `api/app/ops.py`. Its docstring becomes the MCP tool description, so say *when* to use the op, not just what it does.
2. Decorate it with `@operation` from `registry.py`, which only appends the function to a list.
3. `main.py` loops over the registry and exposes each function as an MCP tool (`FastMCP` from the `mcp` SDK, streamable HTTP, mounted at `/mcp`, run in the threadpool) and as `POST /api/op/<name>` (body = kwargs). Never write a route or tool by hand. The one exception is `POST /api/chat` (`chat.py`), which runs the app agent for the web chat. It isn't an op.
4. Return plain JSON-able dicts, and parse the JSON-string props (`schema`, `scope`, `preview`, `spec`, `reads`) before returning them.
5. Check it: `curl -X POST localhost:8000/api/op/<name> -H 'content-type: application/json' -d '{...}'`, then try it from Claude Code in `agent/`.

## Proposal mechanics (shared by SchemaVersion, Transform and Visual)
Write one generic helper set in `graph.py` and use it for all three proposal types:
- `create_proposal(label, view_id, props, parent_id)`: sets the id, `status='pending'`, `created_at` and the `REVISES` edge.
- `approve(id, by)`, done in a single transaction:
  ```cypher
  MERGE (c:Counter {name:'global'}) ON CREATE SET c.value = 0
  SET c.value = c.value + 1
  WITH c MATCH (p {id:$id}) WHERE p.status = 'pending'
  SET p.status = 'approved', p.counter = c.value, p.decided_by = $by
  ```
  If it's a Transform, also approve the `SchemaVersion`s with `proposed_with = $id` in the same transaction.
- `discard(id, by)`.
- `head(label, view_id)`: `MATCH (p:<label> {view_id:$v, status:'approved'}) RETURN p ORDER BY p.counter DESC LIMIT 1`.

## Other patterns
- Driver: the `neo4j` Python driver over Bolt to `MEMGRAPH_URI`. Use one session per op, and `execute_write` for anything that writes. IDs are short uuid4 hex strings with a prefix (`v_`, `s_`, `t_`, `vis_`, `c_`, `i_`).
- Create indexes on startup, ignoring "already exists" errors.
- **Frontier:** walk upstream from the view through head transforms' `READS` and collect the derived views (including the starting view) that have no approved transform. Doing this in Python, one hop at a time, is fine.
- **`get_graph`** should take one or two queries, not N+1: fetch all views, all proposals (without `html` or `preview`, to keep the payload light) and all `READS` edges, then assemble them in Python.
- **Rows are not in Memgraph.** All rows and record lineage go through `app/pg.py` (Postgres, `PG_DSN`):
  - `write_raw` for append-only source batches, `write_derived` for instance tables;
  - `read` and `by_rids` for reading;
  - `meta.tables` maps a rid prefix to its table.

  Memgraph keeps only the manifests (`Instance.storage`) and the instance-level `FROM` edges.
- Use Memgraph Lab (localhost:3000) to eyeball the graph after each op. That's the fastest debugging loop. `scripts/reset.py --all` wipes everything; `scripts/reset.py <prefix>` removes only views named `<prefix>*`.
