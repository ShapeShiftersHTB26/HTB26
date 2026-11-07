---
name: reverse-step
description: Work upstream from an approved view toward existing data, one transform at a time — propose how to compute a frontier view (and any new input view it needs), iterate, approve, repeat until everything reads from source views. Use after a view's shape is approved and the user wants it computed, or wants to change how a view is computed.
---

# Work upstream to existing data

Repeat this loop until `get_frontier(view_id)` returns nothing.

## 1. Pick the next view
- Call `get_frontier(view_id)` on the view the user is working on. If it's empty, every view is resolved: tell the user, and offer `evaluate-trace`.
- Take the frontier view **closest to the user's view**. Read its head shape with `get_view`, and read the shapes of the candidate inputs (source views and other approved views in `get_graph`). Use `get_records` to check real values.

## 2. Decide on one step back
Ask: *can this view be computed directly from an existing view in about 1–4 simple ops?*
- **Yes:** propose a transform that `reads` that view, with no `new_inputs`.
- **No:** propose a transform that reads a **new intermediate view**, and define it in `new_inputs` (`name`, `schema`, `grain`, `scope`, `preview`). The intermediate view should be meaningful to look at, such as "flat sales in Reading with district and year", not a technical half-step.

**When the leaf needs raw data that no source view has** (or the user hasn't picked a dataset yet in a research thread), don't invent a source. Use `find-dataset` to offer one, and continue once a source view exists.

Make sure the transform honours the target's **grain and scope**: the scope usually becomes filters, and the grain usually becomes the aggregate's `by`.

Choose the transform kind:
- `ops` by default. These are declarative steps over exactly one input:
  ```json
  {"ops": [
    {"op": "filter", "where": "(property_type == 'F') & (district == 'READING')"},
    {"op": "derive", "column": "year", "expr": "pd.to_datetime(date).dt.year"},
    {"op": "derive", "column": "postcode_district", "expr": "postcode.str.split(' ').str[0]"},
    {"op": "aggregate", "by": ["postcode_district", "year"],
     "metrics": {"avg_price": ["price", "mean"], "n_sales": ["price", "count"]}}
  ]}
  ```
  Expressions are pandas over column names; combine conditions with `&` and `|`, and parenthesise each one. Also available: `sort {by, desc}` and `limit {n}`.

  Ops run in order. After `aggregate` + `sort`, a `derive` can compare rows, e.g. year-on-year change: `{"op": "derive", "column": "change_pct", "expr": "(median_price.pct_change() * 100).round(1)"}`. Use `.shift()` or `.cumsum()` for similar cases. Don't drop a column because it needs the previous row.
- `agent_map` `{prompt, batch_size}` to infer or classify something for **each row**.
- `agent_reduce` `{prompt, max_rows}` to judge **a whole table** (rank, find notable trends, summarise). Put it after aggregation so the input is small.

## 3. Propose and iterate
- Call `propose_transform(view_id, kind, spec, reads, new_inputs, rationale)`. The rationale is one line on how and why.
- Tell the user in one or two lines, e.g. "To get the average price per district and year, I group flat sales by district and year. That needs a `reading_flat_sales` view, which I've proposed too."
- Feedback gets a sibling (`parent_id`). Approving the transform also approves the new input views proposed with it.
- The user may ask in natural language to change an existing transform ("use median"). Propose a sibling of its current head.
- With auto-accept on, approve with `by: "auto"` and go back to step 1.
