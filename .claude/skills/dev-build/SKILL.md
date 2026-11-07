---
name: dev-build
description: Start here for any Backtrace development work: what to build next, stage order, scoping rules and which dev skill to use. Use when beginning a session, picking the next task, or unsure how much to build.
---

# Building Backtrace

1. Read [BRIEF.md](../../../BRIEF.md) (the idea) and [docs/SPEC.md](../../../docs/SPEC.md) (the build spec). The spec is the source of truth for the graph model, ops, visuals, transforms and UI.
2. Find the first unchecked stage (S0–S5) in the spec. Build only that stage, end to end, and only the ops tagged with that stage.
3. Check it with `dev-run`, tick it off in the spec and commit.

## Rules
- **The demo path is everything.** Make the happy path work, put `# TODO` on edge cases and move on.
- **Thin slices:** one op → visible in the UI → usable from Claude Code. Then the next.
- **Hardcode first** (mark it `# HACK`). No auth, no migrations, no unit tests. `scripts/smoke.py` is the only test.
- **Keep the ops in one place:** every capability is an op in `api/app/ops.py`, which makes it available over both MCP and REST automatically (`dev-api`).
- **It's a view transformer, not a Price Paid app.** Nothing outside the seed scripts may mention a specific dataset.
- If you need to change the spec, change `docs/SPEC.md` in the same commit.
- **Dev and app are separate:** dev skills are `.claude/skills/dev-*`. The app agent's skills are in `agent/.claude/skills/`; edit them when a stage adds app behaviour.

## Which skill
| Working on | Skill |
|---|---|
| graph model, proposals, Cypher, ops registry, MCP/REST | `dev-api` |
| executor, source/ops/agentic transforms, trace | `dev-transforms` |
| React UI, canvas, proposal cards, visual iframe | `dev-web` |
| running, resetting, seeding, smoke test, demo prep | `dev-run` |
| how the app agent behaves | edit `agent/.claude/skills/*` |
