---
name: evaluate-trace
description: Evaluate approved views to produce real data, summarise the answer, and explain where any number came from by tracing records back to the raw source rows. Use when a view's chain reaches existing data, when the user asks to run or refresh a view, or asks "where does this number come from / why is X so high".
---

# Evaluate and explain

## Evaluate
- Call `evaluate(view_id)`. Upstream views without an instance are evaluated automatically, and the latest instance of each input is used by default. To use a specific earlier observation, pass `inputs: {view_id: instance_id}`.
- If evaluation fails, read the error. It's usually a wrong column name or code value in a transform. Fix it by proposing a sibling transform (`reverse-step`), get it approved, and re-evaluate.
- Report the result in 1–3 lines: the row count, any invalid rows, and the headline of the answer, using the rows from `get_records`. The visuals now show real data in the UI.

## Trace ("where does this come from?")
1. Find the record: the user may give you a rid from the UI; otherwise use `get_records(view_id, where={...})` and take its `rid`.
2. Call `trace(rid)`.
3. Explain the chain from the output down to the raw data, one line per level: the view, how it was computed (in plain language) and how many records went in. For example: "£312k = mean of 37 flat sales in RG1 in 2024 ← from 2,140 Reading sales ← Price Paid rows (sample: …)".
4. For `agent_reduce` outputs, point out which rows the model cited.

If the user asks *why* a number looks the way it does, answer from the traced evidence (outliers, small counts). A new breakdown is a new view: use `question-to-shape` or `derive-downstream`.
