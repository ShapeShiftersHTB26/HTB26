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
python scripts/reset.py               # wipe the graph   (talks to the api over REST)
python scripts/seed.py                # ingest the seed data from data/raw/   (from S2)
```
Then start the app agent: `cd agent; claude`. `agent/.mcp.json` configures the `backtrace` MCP server. Check that `/mcp` in Claude Code shows it connected.

## Smoke test (`scripts/smoke.py`, run it before each commit)
It uses only the Python standard library (`urllib`) against REST, prints PASS or FAIL for each step, and runs only the steps for the stages done so far:
- **S0:** `ping` is ok and the memgraph check passes; `get_graph` responds.
- **S1:** propose a shape, comment, propose a sibling, approve it; `get_view` shows the head as the sibling.
- **S2:** propose a visual and approve it; ingest a small source; propose a transform that reads it and approve it; `get_frontier` returns nothing.
- **S3:** `evaluate` returns `row_count > 0`; `trace` of the first record ends at the source.

## Troubleshooting
- **Postgres:** `ping` reports `postgres: false` with an error if `PG_DSN` (in `.env`) is missing or the cluster is unreachable. A full `scripts/reset.py` also drops the `raw`, `derived` and `meta` schemas.
- **api can't reach Memgraph:** use `bolt://memgraph:7687` inside compose. Memgraph takes a few seconds to start, so the api retries on startup.
- **MCP "Pending approval":** the first `claude` run in `agent/` asks you to approve the project's `backtrace` server. Accept it once per machine.
- **MCP not showing in Claude Code:** `curl -i localhost:8000/mcp/` should not 404. Restart `claude` in `agent/`, and check the trailing slash in `.mcp.json`.
- **The UI isn't updating:** check the network tab for `get_graph` polling, and check that the Vite proxy target is `http://api:8000` inside compose.
- **Odd graph state:** open Lab (localhost:3000) and run `MATCH (n) RETURN labels(n), count(*)`.

## Demo prep (S5)
- Rehearse the demo in the spec twice, first step by step and then with auto-accept.
- Warm the agentic cache. Take a snapshot of a good graph by copying the `mg_data` volume while Memgraph is stopped, and take screenshots as a fallback.
