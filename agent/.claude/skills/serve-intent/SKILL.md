---
name: serve-intent
description: Entry point for EVERY user request — record it as an Intent (anchored on the view the user is exploring, or none for a fresh question), serve it through the other skills with intent_id on every proposal, and resolve it with its result and a one-line answer. Use whenever the user asks for something new ("show me the distribution of prices", "which district peaked?", "now only flats").
---

# Serve an intent

An Intent is the user's request plus the path built to answer it. The canvas shows the request and its outcome, and folds the path underneath. Getting the Intent right is what lets the user see the answer first and "lift the hood" later.

## 1. Start or continue
- Call `get_graph` and check `intents`. If the user is continuing an **open** intent (answering your question, giving feedback), keep using that `intent_id`.
- Otherwise call `start_intent`:
  - `text`: the request, word for word.
  - `anchors`: the views the request starts from. If the user says "I'm looking at X" or "for this dataset", or the request obviously refers to one view, use that view's id. For a fresh question, use none.
  - `parent_id`: the previous intent, if this refines or follows up on it ("now only flats", "and as a map").
  - `mode`: leave it unset for the default (anchored → `auto`, fresh question → `guided`), unless the user says "just do it" (`auto`) or "let me approve each step" (`guided`).

## 2. Serve it
Pass `intent_id` to **every** `propose_schema`, `propose_transform` and `propose_visual` call.
- **Exploring an anchored view:** the result is usually a derived view plus a visual. Use `derive-downstream` to build a view computed from the anchor, then `propose-visual`. Example: "distribution of prices" on a sales table becomes `price_distribution [price_band (dimension, GBP), sales (measure, count)]`, built with ops. Derive `price_band` with a readable binning expression, e.g. `(price // 50000) * 50000`, then aggregate a count by band. Then propose a histogram visual. Bucket in a view, not in the HTML, so that every bar traces back to its sales.
- **Fresh question:** `question-to-shape`, then `reverse-step` until the frontier is empty, then `propose-visual`.

**Mode decides approvals:**
- **auto:** approve each of your own proposals as soon as you make it (`decide(..., by: "auto")`). Evaluate when the chain is complete, then resolve. Keep rationales good: they are the story the user reads under the hood.
- **guided:** stop after each proposal and let the user decide, as in the other skills.

## 3. Resolve
Once the result exists and has data (evaluate it, see `evaluate-trace`), call `resolve_intent`:
- `result_id`: the visual that answers the request (preferred), or the view.
- `summary`: one or two sentences that **answer** the request in plain words, using real numbers from `get_records`, e.g. "Most 2025 Reading sales were £250k–£350k; the median was £335k."

Then tell the user in one or two lines. Mention that the Outcomes lens shows the request and its answer, and that clicking the intent shows how it got there.
