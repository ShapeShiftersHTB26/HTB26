# Backtrace (HTB26 hackathon)

> If you were launched from `agent/`, you are the **app agent**: follow `agent/CLAUDE.md` and ignore this file.

Development guidance:
- Idea: [BRIEF.md](BRIEF.md). Build spec (graph model, ops, transforms, UI, milestones): [docs/SPEC.md](docs/SPEC.md).
- Start with the `dev-build` skill. The dev skills are `.claude/skills/dev-*`. The app agent's skills are in `agent/.claude/skills/`.
- Hackathon mode: the happy-path demo beats completeness. Use small iterations and keep the stack runnable after every change.
