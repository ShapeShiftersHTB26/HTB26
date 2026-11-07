---
name: dev-web
description: Build or change the Backtrace web UI — react-flow canvas of views, proposal cards (shape/transform/visual) with approve/discard/comment, sandboxed HTML visuals, data tab and trace drawer. Use when working in web/.
---

# web: one page, rendered from the graph

The layout and the visual contract are in [docs/SPEC.md](../../../docs/SPEC.md) (Web, Visuals). The UI holds **no state of its own** beyond what's selected: it polls `get_graph` every 2s, fetches `get_view` for the selected view, and calls ops through `POST /api/op/<name>`.

## Structure
```
web/src/api.ts             op(name, args) -> fetch('/api/op/'+name)
web/src/App.tsx            polling + selected view + layout
web/src/Canvas.tsx         react-flow + dagre (TB): view, data and visual nodes; transform and uses edges
web/src/ViewPanel.tsx      tabs: Shape | Visual | Transform | Data
web/src/ProposalCards.tsx  generic sibling cards + approve/discard/comment; takes a renderBody prop
web/src/VisualFrame.tsx    sandboxed iframe: injects window.BACKTRACE, listens for postMessage select
web/src/Visual.tsx         loads the views a visual `uses`, renders VisualFrame
web/src/VisualWindow.tsx   floating draggable/resizable window per visual (App keeps the window list)
web/src/IntentPanel.tsx    intent story, Open result, Ask a follow-up
web/src/RowsTable.tsx      plain table; the fallback when there's no visual
web/src/TraceDrawer.tsx    (S3)
```

## Guidelines
- **Proposal cards** are the heart of the UI, and there's one component for all three proposal types:
  - Show siblings side by side and highlight the approved chain.
  - Pending cards get Approve, Discard and Comment buttons. Discarded cards are greyed out but still visible.
  - Every card shows the author (agent or user), the rationale and its comments.
  - Shape body: a column list (name, type, role, unit), the grain, scope chips and a preview table.
  - Visual body: `VisualFrame` over the preview rows, or over the latest instance once there is one.
  - Transform body: the ops in plain language, e.g. "filter: property_type == 'F'", "group by postcode_district, year → avg_price = mean(price)".
- **VisualFrame:**
  - Build `srcdoc` by putting the injection script from the spec in front of the agent's HTML, and use `sandbox="allow-scripts"` only.
  - Fix the height (e.g. 360px) to avoid resize plumbing.
  - Listen to `message` events with `type === 'select'`.
- **Canvas:** a dagre top-to-bottom layout over view, data and visual nodes. Node ids are prefixed `v:` `d:` `x:`, and clicking a node opens the view's panel on the matching tab. Keep the layout automatic; don't hand-position nodes.
- Styling: one CSS file, large fonts readable on a projector, one accent colour for agent-authored and agentic items. No state library, no router, no component library.
