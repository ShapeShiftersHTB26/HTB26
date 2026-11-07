---
name: ingest-source
description: Bring a new structured dataset (CSV in data/raw) into Backtrace as a source view, then refine its schema annotations. Use when the user wants to add a dataset, or a view needs data that no source view has.
---

# Add a source dataset

1. **Locate the file.** It must be in `data/raw/`, which the api sees as `/data/raw/...`. If the user hasn't said which file, ask for the file and a short `name`.
2. **Ingest:** call `ingest(path, name, columns?, filter?, parse_dates?, limit?)`.
   - Headerless CSVs need `columns`.
   - Keep it small for the demo with a `filter` expression or a `limit`.
   - This creates the source view, an inferred schema and the records.
3. **Refine the schema:** the inferred roles are crude. Look at `get_records` (limit 10), then propose a sibling shape (`parent_id` = the inferred version) that:
   - fixes the `x-role`s (ids → `id`, money → `measure` with `x-unit`);
   - adds short `description`s, especially for coded columns, with what each code means;
   - sets `grain` (e.g. "one row per transaction") and `scope` (e.g. "Reading district, 2023–2024").

   Approve it yourself if auto-accept is on; otherwise let the user approve it.
4. Report the row count and a one-line summary of what the dataset contains.

**New data for an existing source** (e.g. next year's file): don't ingest a new view. Call `append_batch(view_id, path)`. It runs the same recipe and publishes a new snapshot that contains all batches. Downstream views pick it up when they're re-evaluated (`evaluate`), and their hashes change accordingly.
