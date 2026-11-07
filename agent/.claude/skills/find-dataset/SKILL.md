---
name: find-dataset
description: When a view's chain needs raw data, offer public datasets from the curated catalog as cards in the research chat, then load the one the user picks as a source view. Use in reverse-step when the leaf needs data, or when the user asks "what data could answer this?".
---

# Find a dataset and load it

## 1. Offer candidates
- Call `list_datasets(query)` with words from the data the leaf needs, e.g. "house prices sales flats".
- Pick the 1–3 entries that fit best. Prefer `available: true` entries, since only those load right now. An unavailable entry can still be offered as an alternative, but say it isn't downloaded yet.
- Show them as cards: `say(intent_id, text, datasets=[ids])`. The `text` is one or two sentences: what the leaf needs, and why the first card fits, e.g. "We need individual sales with price, date, property type and district. HM Land Registry Price Paid has every sale in England & Wales."
- Stop and let the user choose. In auto mode, pick the best available one yourself and continue.

## 2. Load the pick
The user's choice arrives as `[action] Use dataset <id> …`.
- Choose a **filter** that keeps the data small and matches the target's scope, using the entry's `notes` for codes, e.g. `district == 'READING'`.
  - Keep the source broad enough to be reused: filter by place, not by property type. Property type belongs in a transform.
- Call `ingest_dataset(dataset_id, name, filter, intent_id=...)`.
  - The name follows the pattern `price_paid_reading`.
  - If a source view already exists from the same dataset and filter, it is reused; the result has `reused: true`.
  - Either way a "data loaded" card appears in the chat.
- Continue upstream with `reverse-step`: the leaf transform now `reads` the source view. Check real values with `get_records` before writing filters.

## 3. Unavailable datasets
If the user picks one that isn't downloaded, say so in one line, and offer the closest available dataset or the parts of the question we can answer now.
