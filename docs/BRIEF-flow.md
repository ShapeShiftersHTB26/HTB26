# User flow: from a question to research, and on to the future

*Status: agreed direction, being refined. It drives the next UI work and the pitch. The concepts are in [BRIEF.md](../BRIEF.md) and the market mechanics in [BRIEF-markets.md](BRIEF-markets.md).*

## Punchline
**Backtrace is a flexible research tool.** You start with a question, not a dataset. Backtrace works out what data you need and in what shape, finds a public dataset, helps you load it, and explores it with you. Every number traces back to its source rows.

Once you have an answer that changes over time, it asks: **"Would you like to look into the future?"** Prediction markets come in from there, as an add-on that grows out of the research rather than being the reason to come.

## Principles
- **One question, one thread.** The whole journey is a single chat-style thread: an Intent on the graph. Each step appears in it as a card you can approve, edit or comment on.
- **Introduce each concept when it's first used.** The landing explains nothing. Shapes, sources, traces, hashes and markets each get a one-line caption the first time they appear.
- **The graph stays behind "lift the hood".** The lineage canvas, Detail lens and transform internals are one click away, never in front.
- **The agent proposes, you decide.** Nothing becomes current without approval, unless you switch auto-accept on.
- **The graph is still the only state.** Chat messages, candidate datasets and market drafts are graph nodes like everything else, so the UI, MCP and the terminal all see the same thread.

## Layout: chat and canvas
The chat and the work are kept apart.
- **Landing:** you start in a big chat box.
- **After the first question:** the box shrinks into a **floating chat window**, and the main area becomes the thread's **canvas**. The canvas fills up as you go, and is the graph you built for this question.
- **The chat is conversation only.** Each proposal in it is a short link that jumps to the node it changed.
- **The canvas holds the work:**
  - **Text nodes:** the question's breakdown, assumptions, findings and the answer summary. The agent writes them, and you can add your own.
  - **Table nodes:** an evolving view, showing its columns and its preview or real rows.
    - **A proposed change is drawn on the table** as a diff against the approved version: new columns marked **+**, removed ones struck through, new rows as ghost rows. Accept and Discard are on the node.
    - **The empty future row** lives here too.
  - **A "?" leaf** where data is missing. It holds the dataset cards, and turns into a source node once you pick one.
  - **Visual nodes** that open into floating windows.
- **Focus links the two:**
  - clicking a node focuses it, and the chat shows "about: *view*", so "add a column for number of sales" lands on that table as a pending diff;
  - the agent can focus the node it's working on, and the canvas pans to it.
- **Layout and scope:** the layout is automatic (top to bottom), and each research thread has its own canvas. The Graph tab still shows everything.

## Screens
- **Landing:**
  - A centred headline, **"What would you like to research today?"**, with one line beneath it: *"Start with a question. We'll work out what data you need, find it, help you load it and explore it with you. Every number traces back to its source."*
  - One input box.
  - Three example chips, all plain research questions within Price Paid data: *"How have Reading flat prices changed?"*, *"Where in Reading do homes sell fastest?"*, *"Are new builds selling at a premium?"*
  - Under them, a dim strip of the journey: **Ask → Shape → Data → Explore**.
- **Thread:**
  - The strip moves to the top as a progress rail and lights up as you go. **Future** appears as a fifth step only once it's offered.
  - Below the rail is the thread column with the input box at the bottom.
  - Visuals open as floating windows, as they do now.
  - A collapsible **Lineage** pane shows the canvas, scoped to this thread.
  - A thread list sits on the left, with a small "Needs you" count of pending proposals.

## The flow
Each stage lists what you see, what the agent does, and what we already have. The example running through is *"Will the flat market in Reading grow next year?"*

### 1. Ask: sharpen the question
**You see:**
- the agent restating the question as its parts, as editable chips:
  - **what:** flats
  - **where:** Reading district
  - **measure:** median sale price (alternative: number of sales)
  - **period:** by year
  - **compare:** year on year
- a **target table card** with columns, units, grain and scope, and greyed placeholder rows;
- the caption *"This is the shape of your answer. Approve it or change it."*

**Agent:** `start_intent`, then `propose_schema` with an illustrative preview. You iterate in chat or with comments, then approve.

**Built:** intents, shape proposals, comments, approval. **Missing:** chat in the UI; placeholder rows styled as illustrative.

### 2. Shape: unwrap it into data components
**You see:**
- a small tree, not the graph: *year-on-year change ← yearly median ← flat sales in Reading ← ❓ property transactions (price, date, type, district)*;
- the leaf with no data highlighted as **needs data**;
- the caption *"To answer this, we need these ingredients."*

**Agent:** reverse-steps from the target: upstream views with shapes and transforms, down to a leaf that names the raw data it requires.

**Built:** reverse-step skill, upstream proposals, `get_frontier`. **Missing:** a "needs data" state for a view whose shape is approved but which has no source yet, and the compact tree card.

### 3. Data: find a dataset and load it
**You see:**
- dataset cards, one per candidate, each with publisher, licence, coverage, how recent it is, size, and why it fits. For example: *HM Land Registry Price Paid Data (OGL, monthly, 1995 to now)*, with ONS House Price Index as an alternative.
- **Use this** on a card, which starts a progress card: download → recipe (filter to Reading) → batch written → row count and hash;
- then the needs-data leaf turns solid.

**Agent:** searches the web for public datasets, proposes the candidates, and after your pick proposes the ingest recipe (columns, filter, dates). The recipe is approved like any other proposal.

**Built:** `ingest` from a local file, recipes, batches, hashes, `append_batch`; the agent's web tools. **Missing:**
- a `find-dataset` app skill;
- a *source candidate* proposal kind;
- `ingest_url`, which downloads into `data/raw/`, records the sha256 and reuses a file already on disk for the same URL (this keeps the demo fast).

### 4. Explore: answer, ask why, go further
**You see:**
- **The answer.** The tree fills in with real numbers and the result table appears with a small fingerprint badge: hash ✓ verified.
- **Why this number?** Clicking any value unfolds an inline strip: the value → the rows it came from → the raw Land Registry records, each with its batch and hash. Caption: *"Every number has a receipt."*
- **Visuals** such as a map, a trend line or a distribution, proposed and approved, then opened in floating windows.
- **Follow-ups** in the input box, e.g. *"by postcode district"* or *"only new builds"*. Each one creates a downstream view in the same thread.

**Built:** evaluate, trace, verify, visuals, windows, downstream views, follow-up requests. **Missing:** the inline "why" strip (it replaces the trace drawer) and running all of it inside the thread layout.

### 5. Future: "Would you like to look into the future?"
This is offered only when the current view has a time column and its latest period is complete. Each step introduces one idea:
1. **The empty row.** The table gains a 2026 row whose value is **?**. Caption: *"The data stops here. This cell will be filled when Land Registry publishes 2026 sales, using exactly the same calculation as the rows above."* The future is defined as precisely as the past.
2. **A naive guess** (optional). A clearly labelled trend line: *"If the last 3 years continue: about £X."* It's drawn by the visual, not stored as a view, so it never enters the hashed chain. It shows that a prediction is just a value for that cell.
3. **What others think.** *"Others might see it differently. Want to ask them?"* The agent drafts a market on that exact cell:
   - **target:** the view, row and field;
   - **condition:** for example *2026 median ≥ the 2025 median*;
   - **times:** trading close and resolve-after;
   - **pin:** the formula hash it commits to.

   Approving it creates the market on the Solana backend, which opens a market window for trading.
4. **Settling it.** When the data arrives it is appended as a batch. The pinned chain is re-evaluated and verified, the cell fills in, and the market settles with the proof hash. **On stage we show this as a backtest:**
   - the same market as of 2024 → 2025;
   - append the 2025 batch;
   - it settles and verifies live.

**Built:** formula hashes, instance hashes, verify, append_batch; MIDAV0's market program and backend. **Missing:**
- the future-row presentation;
- a *market draft* proposal kind;
- the handoff to the market backend (`POST /markets`, then resolve with the proof), described in [BRIEF-markets.md](BRIEF-markets.md).

## Captions shown the first time each concept appears
| Moment | Caption |
|---|---|
| First target table | This is the shape of your answer. Approve it or change it. |
| First needs-data leaf | To answer this, we need these ingredients. |
| First dataset card | Public data we found that fits. Pick one and we'll load it. |
| First hash badge | This fingerprint changes if any underlying row changes. |
| First "why" | Every number has a receipt. |
| Future row | This cell will be filled using exactly the same calculation as the rows above. |
| First market | Because the answer can be re-computed and checked, people can trade on it. |

## Demo script (about 4 minutes)
1. **Landing** → click the chip *"How have Reading flat prices changed?"*, then type the sharper *"Will the flat market in Reading grow next year?"*
2. **Sharpen** → change the measure to median and approve the target table.
3. **Unwrap** → the tree with a missing leaf.
4. **Find data** → the HMLR Price Paid card → **Use this** → loads in seconds from the pre-downloaded file.
5. **Answer** → the yearly medians → click 2025 → "why" unfolds to raw sales → hash ✓.
6. **Explore** → *"by postcode district"* → map window.
7. **Future** → the empty 2026 row → the naive guess → *"ask others"* → the market opens.
8. **Backtest** → *"Let's see how this would have played out last year"* → the 2024→2025 market settles from the appended 2025 batch and verifies.

## Build order
Each step keeps the stack runnable and demoable.
1. **Chat thread.**
   - Message nodes on Intent, plus `post_message`.
   - A **runner** that answers new user messages by running `claude -p` in `agent/` and resuming that thread's session. The session id is stored on the Intent.
   - A thread UI that renders messages and existing proposal cards in order.
2. **Landing and rail.** The landing screen and chips; stage derived from the thread's state.
3. **Sharpen and unwrap.** Prompts for the question-to-shape and reverse-step skills; the needs-data state; the tree card.
4. **Find and ingest.** The `find-dataset` skill, source-candidate proposals, `ingest_url` with the on-disk cache.
5. **Why strip** inline in the result table.
6. **Future.** The empty row and the naive-guess visual.
7. **Market.** The market-draft proposal, the handoff to MIDAV0's backend, the market window, and the backtest settle.

## Open questions
- **Runner.** `claude -p` per message (proposed) versus a long-lived terminal session that watches for messages. How do we show the agent "thinking" while it runs: a typing state, or streaming the proposals as they land?
- **Market API.** Agree the create and resolve payloads with MIDAV0: `spec_hash`, `trading_close` and `resolve_after`.
- **Discovery.** Live web search, or a short curated list the agent picks from, with live search as a fallback? Live is more impressive but riskier on stage.
- **The naive guess.** Keep it, or go straight from the empty row to "ask others"?
- **The existing canvas UI.** Keep it as a "lift the hood" view of everything, alongside the threads?
