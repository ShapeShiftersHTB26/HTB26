---
name: propose-visual
description: Propose an HTML visual for an approved view — a self-contained page that reads the view's rows and renders a chart, cards, map or table, with click-to-trace. Use when a view's shape is approved and the user wants to see it, or asks to change how a view looks.
---

# Propose a visual

## 1. Read the view
`get_view(view_id)` gives the head shape (columns with roles and units, grain, scope, preview). Pick the form that best answers the view's question:
- time + measure → line chart (one line per dimension value)
- dimension + measure → bar chart
- a single record → a big number or KPI card
- text → cards
- geo → points on a map

## 2. Write the HTML
Write a complete, self-contained HTML document. At runtime the page gets:
```js
window.BACKTRACE = { schema, rows, mode: "preview" | "instance", view: { id, name } }
window.backtraceSelect(rid)   // call on click; opens the trace drawer
```
- Read the data **only** from `window.BACKTRACE.rows`. Never hardcode values, because the same HTML must work on preview rows and on real data.
- On click, call `backtraceSelect(row._rid)` when `row._rid` exists. Preview rows don't have one.
- Show the units from the schema (`x-unit`) on axes and labels. Use the view name and grain as a small title.
- Libraries: plain SVG or Canvas is safest. Vega-Lite via `https://cdn.jsdelivr.net/npm/vega@5`, `vega-lite@5` and `vega-embed@6` is fine; use `signalListeners` or the view's click handler to get the datum's `_rid`.
- Design for a 360px-tall frame: large readable text, one accent colour, and a legible light background.
- If `mode === "preview"`, show a small "preview" badge.

**Several visuals per view:** omit `parent_id` to **add** another visual (existing ones stay); pass `parent_id` only to revise that particular visual.

**Visuals that use several views (`uses`):** if a visual needs data the view doesn't have, such as coordinates or boundaries for a map, never hardcode it in the HTML and don't widen the view. Instead:
1. Create or reuse a **reference view** keyed by the join column, e.g. `district_locations [postcode_district, lat, lon]` (see `derive-downstream`, `agent_map`).
2. Propose the visual on the main view with `uses: [reference_view_id]`. Its rows arrive as `window.BACKTRACE.views["district_locations"].rows`.
3. Join the two in the HTML on the key (`postcode_district`). Both views' real rows carry `_rid`, so clicking still traces.
4. Leave a `comment` (author `agent`) on the proposal that asked for it, saying where the answer lives.

**Maps:** use Leaflet (`https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js` plus `leaflet.css`) with **CARTO** tiles, `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`, with the attribution "© OpenStreetMap contributors © CARTO". **Do not use tile.openstreetmap.org**: the sandboxed frame sends no referrer, and OSM blocks that under its tile usage policy. Draw circle markers sized or coloured by the measure. If Leaflet fails to load, fall back to a plain SVG scatter of lon/lat.

## 3. Propose and iterate
- Call `propose_visual(view_id, html, rationale)`. The rationale says why this form suits the question.
- Tell the user in one line, and point them to the Visual tab.
- Feedback ("log scale", "bars instead", "highlight RG1") gets a sibling with `parent_id` set.
- With auto-accept on, approve with `by: "auto"`.
