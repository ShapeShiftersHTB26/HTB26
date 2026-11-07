---
name: derive-downstream
description: Derive a new view from an existing one — e.g. averages per year → the single record with the maximum, a top-N, a ranking, a summary — without changing the original view or its visual. Use when the user asks a follow-up question about a view that already exists ("which one peaked?", "top 3", "summarise this").
---

# Derive a new view downstream

The original view is left untouched; its shape, transform and visual stay as they are. The new view is computed **from** it.

1. **Read the source view:** `get_view(source_view_id)` for its head shape, and `get_records` if it has data.
2. **Shape the new view.** Call `propose_schema` with no `view_id`, following `question-to-shape` (name, question, schema with roles and units, grain, scope, preview). Scope and grain are often simple here, e.g. grain "a single record".
3. **Propose its transform straight away,** reading the source view. This is what makes it downstream, and it draws the edge on the canvas:
   - Deterministic, e.g. the maximum: `{"ops": [{"op": "sort", "by": ["avg_price"], "desc": true}, {"op": "limit", "n": 1}]}`. Each output row keeps the source row as its lineage.
   - Agentic (`agent_reduce`) for judgement, e.g. "3 notable trends" or "summarise".
4. Ask the user to approve the shape, then the transform. Each one is a separate decision unless auto-accept is on.
5. Once both are approved, offer a visual (`propose-visual`) and evaluation (`evaluate-trace`).
