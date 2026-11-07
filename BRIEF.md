# Backtrace — answers you can take apart

*Working title · HTB26 hackathon brief*

## Problem
Dashboards and AI assistants hand you a number, but you can't see how it was made or check where it came from.

## Idea
Backtrace is a **flexible view transformer** over structured data. You ask a question in plain text and point Claude at the data you'd like it to use, e.g. *"average annual price of flats in Reading, by postcode district, use the Price Paid sales"*. Together you agree on the **shape of the answer** as a view: its columns, what one row means, its scope and its units. From any agreed view you can move on in three directions:

- **Upstream:** how the view is computed. A transform plus the input views it needs, repeated until the inputs are data that already exists.
- **Downstream:** a new view derived from this one, e.g. averages per year → the single year with the maximum. The original view and its visuals stay as they are.
- **Visual:** how the view is shown. HTML written by the agent that takes the view's data and renders it.

Transforms are deterministic (formulas) or agentic (an LLM classifying, inferring or summarising). Once the views are evaluated, every number in every view can be traced back to the raw datapoints.

## Core concepts
Everything lives on one graph (Memgraph). There's no "final" view, only views connected in either direction.

- **View:** a *definition*: its shape plus the transform that computes it. A raw dataset is a source view. Definitions are the formula.
- **Shape (schema version):** JSON Schema for one row plus annotations (role, units, description), along with the **grain** (what one row is) and the **scope** (e.g. "Reading, flats, 2020–2024"). Each proposal includes preview rows, so a view can be seen before any data exists. Schemas validate data, act as structured input and output for the agent, and drive the UI.
- **Transform:** a versioned node connecting one or more input views to one output view: `(View)-[:COMPUTED_BY]->(Transform)-[:READS]->(View…)`.
- **Visual:** a versioned HTML snippet that renders a view, from preview rows or from a real instance. It can also **use other views**, e.g. a reference view of district locations, which it joins in the browser. A view can have several visuals.
- **Instance:** one *evaluation* of a view. It pins the exact shape and transform versions and the input instances it used. One definition can have many instances. Instances are the observation.
- **Record:** a datapoint in an instance, linked to the source records it came from.

## Process
1. **Question → view:** Claude proposes the view's shape. You iterate on the columns, grain, scope and units, then approve it.
2. **Advance:** from any approved view, propose an upstream transform (plus new inputs), a downstream view, or a visual. You iterate in natural language, in chat or as comments in the UI, then approve.
3. **Evaluate:** once a view's chain reaches existing data, evaluate it. Each input defaults to the latest instance of its upstream view, and you can pick a different one.
4. **Trace:** click any record in any visual and walk its lineage back to the raw rows.

Approval can be step by step, so you follow the reasoning, or **auto-accept**.

## Versioning
Shapes, transforms and visuals all keep an append-only history, following CRDT principles:
- Proposals are immutable nodes. A revision points to its parent, and alternatives are siblings.
- Each approval increments a global counter. The current version is the approved one with the highest counter, i.e. last writer wins. So approving an older sibling later makes it current again.
- Discarded and superseded proposals stay on the graph.

The UI renders the decision state straight from the graph, which gives you a full replay of the reasoning alongside the data lineage.

## Transforms
Every transform is a **pure function**: input records in, output rows out, each row tagged with `_src`, the ids of the records it came from. The executor does everything else: validation, writing records and lineage, and pinning versions.
- **Deterministic:** a short list of declarative ops (filter, derive, aggregate, with join later), written by the agent.
- **Agentic:** the api calls Claude directly, using schemas as the structured input and output.
  - **map:** one output per record, e.g. classifying or inferring coordinates.
  - **reduce:** a whole table in, a few rows out, e.g. ranking or a summary, with each row citing its `_src`.

## Interface
The graph is the **only** state. One service exposes every operation as both **MCP tools** and **REST**. **Claude Code is the agent**: it works over MCP and can run multi-turn, but never depends on its own session memory. The web UI is just another client with the same powers.

## Architecture (docker compose)
- `memgraph` + `memgraph-lab`
- `api`: shapes, transforms, visuals, proposals, evaluation, lineage; serves MCP and REST
- `web`: canvas of views, proposal cards (approve, discard, comment), sandboxed visuals, trace drawer

## Scope for the hackathon
- A demo that works end to end beats correctness.
- We assume the data exists, and accept redundancy (reusing views comes later).
- The demo data is a slice of UK Price Paid. The design doesn't depend on that dataset.
