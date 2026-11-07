---
name: question-to-shape
description: Turn the user's natural-language question (plus any hints about which data to use) into an agreed view — propose columns, grain, scope, units and preview rows, then iterate until approved. Use whenever the user asks a new question of the data ("what's the average…", "show me…", "how did … change"), or wants to change the shape of an existing view.
---

# From a question to an agreed view

## 0. Sharpen the question (fresh research questions)
Start by breaking a vague question into the parts an answer needs, and state them in your reply in one or two lines:
- **what** is measured (e.g. flats);
- **where** (e.g. Reading district);
- **which measure** (median price? number of sales?);
- **period and grain** (by year);
- **comparison** (year on year).

Choose sensible defaults instead of asking. When there's a real choice, offer it as quick replies (`say` with `suggestions`, e.g. ["Median price", "Number of sales"]). Forecast questions ("will it grow next year?") still start from the measurable history: shape the yearly table first, and the future comes later.

## 1. Understand the question and the data hints
- `get_graph` lists the existing views. Source views are data you can build on; other approved views can be reused as well.
- If the user named data ("use the Price Paid sales"), find the matching view. Where records exist, check real values with `get_records(view_id, limit=10)`: codes, spellings, ranges.
- If nothing obviously fits, still shape the view. Shaping doesn't need data. Mention in one line that we'll find the data next (`find-dataset`).

## 2. Propose the view
Call `propose_schema` with no `view_id` (this creates the view):
- `name`: snake_case and descriptive, e.g. `flat_prices_by_district`.
- `question`: the user's question, word for word.
- `schema`: the **minimum** set of columns that answers the question, as JSON Schema for one row. Give every column a `type`, an `x-role` (`dimension`, `time`, `measure`, `geo_lat`/`geo_lon`, `text`, `id`) and a short `description`. Add `x-unit` wherever it applies (GBP, %, count, m²…).
- `grain`: what one row is, e.g. "one row per postcode district per year".
- `scope`: the constraints as short strings, e.g. `["Reading", "flats only", "all available years"]`. Make every interpretation explicit here, e.g. "Reading area read as Reading district".
- `preview`: 3–6 **plausible** rows, with realistic values taken from the data where you can. The UI renders them before any data exists.
- `rationale`: one or two sentences on how this shape answers the question.

Don't propose transforms or visuals yet.

## 3. Iterate
- Tell the user in one or two lines what you proposed and the key assumptions. Ask them to approve it, or say what to change (columns, rows, scope, units), in chat or in the UI.
- Next turn, re-read with `get_view(view_id)`:
  - **Feedback (a comment or chat):** propose a sibling with `parent_id` set to the version they reacted to, changing only what they asked for.
  - **Discarded with no comment:** ask in one line what was wrong.
  - **Approved:** offer the next directions: a visual (`propose-visual`), how to compute it (`reverse-step`), or deriving something from it (`derive-downstream`).
- If auto-accept is on, approve with `by: "auto"` and continue with `propose-visual`, then `reverse-step`.
