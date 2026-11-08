---
name: dev-run
description: Run, reset, seed and smoke-test the Backtrace stack (docker compose + Claude Code app agent), and prepare the demo. Use when asked to start or check the app, verify a stage, or debug services not talking to each other.
---

# Run and check

## Start
```powershell
docker compose up --build -d          # memgraph:7687, lab:3000, api:8000, web:5173
                                      # + prediction-market-{db:5433, validator:8899/8900, backend:8080} (Predictions tab)
docker compose logs -f api            # watch the api while you work
python scripts/reset.py --all         # wipe graph + Postgres data plane (irreversible); `reset.py <prefix>` removes only <prefix>* views
python scripts/seed.py                # ingest the seed data from data/raw/   (from S2)
```
**Research chat (Research tab, the default page):** the api serves research threads itself.
- **How:** `api/app/worker.py` reuses the web-chat agent from `chat.py`, which runs Claude Agent SDK on `ANTHROPIC_API_KEY`.
- **Model:** `BACKTRACE_AGENT_MODEL`, default `claude-haiku-5-5`. Agentic transforms use `BACKTRACE_MODEL`, also `claude-haiku-5-5` by default.
- **Without an API key:** set `BACKTRACE_THREAD_WORKER=off`, then run `python scripts/runner.py` on the host. It uses your `claude` login instead.

To drive the agent from a terminal instead: `cd agent; claude`. `agent/.mcp.json` configures the `backtrace` MCP server. Check that `/mcp` in Claude Code shows it connected.

## Smoke test (`scripts/smoke.py`, run it before each commit)
It uses only the Python standard library (`urllib`) against REST, prints PASS or FAIL for each step, and runs only the steps for the stages done so far:
- **S0:** `ping` is ok and the memgraph check passes; `get_graph` responds.
- **S1:** propose a shape, comment, propose a sibling, approve it; `get_view` shows the head as the sibling.
- **S2:** propose a visual and approve it; ingest a small source; propose a transform that reads it and approve it; `get_frontier` returns nothing.
- **S3:** `evaluate` returns `row_count > 0`; `trace` of the first record ends at the source.

## Production
Run `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`. Its `.env` needs `ACCESS_CODE`, `PG_DSN`, `ANTHROPIC_API_KEY` and `PM_ADMIN_KEY`.
- **Access gate:** the web server asks every visitor for `ACCESS_CODE` before anything loads (`web/access-gate.ts`). That covers the app, `/api` and `/pm-api`. The right code sets a cookie that lasts 30 days.
- **Ports:** only the web port is published. The api has no host port, Memgraph never does (dev included), and Lab doesn't start; use `--profile debug` if you need it.
- **Memgraph is pinned** to `memgraph/memgraph:3.11.0`, so state exports and snapshots stay compatible.

## Moving to a server (state export / import)
Row data lives in Postgres (`PG_DSN`), so a new server only needs the graph and the agentic cache.

1. **Export here:** `python scripts/export_state.py`. This writes `data/state/<stamp>/`, about 300 KB:
   - `graph.jsonl`, a Memgraph `DUMP DATABASE`;
   - `cache.tar.gz`, the agentic cache;
   - `manifest.json` with node counts, the source files used, and a check that every manifest finds its rows.
2. **Copy the folder to the server**, into `data/state/<stamp>/`. Give the server a `.env` with the **same** `PG_DSN`, plus `ANTHROPIC_API_KEY` and `PM_ADMIN_KEY`.
3. **Import on the server:** `python scripts/import_state.py <stamp>`.
   - It refuses a non-empty graph. Add `--replace` to wipe the server's **graph** first; Postgres is never touched.
   - It then checks that every manifest finds its rows and spot-verifies a few small results.
4. **Source CSVs (`data/raw`)** are optional on the server. You only need them for new ingests, appended batches, exported notebooks and verify's file checksums.
5. **Check later** with `python scripts/import_state.py --check`.
6. **Don't share one Postgres between dev and prod:** the graphs drift apart, and an `--all` reset from either side hits both.

## Troubleshooting
- **Postgres:** `ping` reports `postgres: false` with an error if `PG_DSN` (in `.env`) is missing or the cluster is unreachable. A full `scripts/reset.py --all` also drops the `raw`, `derived` and `meta` schemas.
- **api can't reach Memgraph:** use `bolt://memgraph:7687` inside compose. Memgraph takes a few seconds to start, so the api retries on startup.
- **MCP "Pending approval":** the first `claude` run in `agent/` asks you to approve the project's `backtrace` server. Accept it once per machine.
- **MCP not showing in Claude Code:** `curl -i localhost:8000/mcp/` should not 404. Restart `claude` in `agent/`, and check the trailing slash in `.mcp.json`.
- **The UI isn't updating:** check the network tab for `get_graph` polling, and check that the Vite proxy target is `http://api:8000` inside compose.
- **Research chat stuck on "reading your message…":**
  - Check `docker compose logs api` for worker errors.
  - Check that `ANTHROPIC_API_KEY` is set, or that the host runner is running if the worker is off.
  - Restarting the api re-queues threads that were mid-turn.
- **Odd graph state:** open Lab (localhost:3000) and run `MATCH (n) RETURN labels(n), count(*)`.

## Demo prep (S5)
- Rehearse the demo in the spec twice, first step by step and then with auto-accept.
- Warm the agentic cache. Take a snapshot of a good graph by copying the `mg_data` volume while Memgraph is stopped, and take screenshots as a fallback.
