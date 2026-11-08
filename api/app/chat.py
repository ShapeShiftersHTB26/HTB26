"""Web chat: runs the app agent (Claude Code, via the Claude Agent SDK) and streams its replies to the UI.

It is the same agent you get by running `claude` in agent/: it loads agent/CLAUDE.md and agent/.claude/skills and
works only through this api's own MCP tools. The canvas picks up whatever it writes to the graph on its next poll,
so the stream only carries the agent's words plus a one-line label per tool call.

SSE events, one JSON object per `data:` line:
  {"type": "session", "session_id"}   send session_id back with the next message to continue the conversation
  {"type": "text", "text"}            reply text
  {"type": "tool", "label"}           a tool call, e.g. "propose_schema · flat_prices_by_district"
  {"type": "tool_error", "text"}      a tool call that failed
  {"type": "note", "text"}            status worth showing, e.g. an expired session was replaced
  {"type": "done", "is_error", "turns", "cost_usd", "errors"}
  {"type": "error", "message"}
"""
import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

import anyio
from claude_agent_sdk import (AssistantMessage, ClaudeAgentOptions, ResultMessage, SystemMessage, TextBlock,
                              ToolResultBlock, ToolUseBlock, UserMessage, query)

AGENT_DIR = os.environ.get("AGENT_DIR", "/srv/agent")
MCP_URL = "http://localhost:8000/mcp/"  # this api's own MCP endpoint
# Web chat + research threads; Haiku by default: it's billed per turn on the API key.
MODEL = os.environ.get("BACKTRACE_AGENT_MODEL") or "claude-haiku-5-5"
# What the chat model selector may pick (short name -> model id). Anything else is refused: the URL is public.
MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}


def pick_model(name: str | None) -> str | None:
    """A selector value (short name or model id) -> model id; None = the default. Raises on anything else."""
    if not name:
        return None
    if name in MODELS:
        return MODELS[name]
    if name in MODELS.values():
        return name
    raise ValueError(f"model must be one of {sorted(MODELS)}")
MAX_TURNS = 80  # HACK: runaway guard; serving a full intent takes roughly 20-40 tool calls
_RUNS: set[asyncio.Task] = set()


def _app_skills() -> list[str]:
    """Only the app skills in agent/.claude/skills, not Claude Code's bundled ones (init, code-review, ...)."""
    root = Path(AGENT_DIR, ".claude", "skills")
    return sorted(p.name for p in root.iterdir() if (p / "SKILL.md").exists()) if root.is_dir() else []

WEB_CHAT = (
    "You are talking to the user through the chat panel of the Backtrace web app, not a terminal. The canvas next "
    "to the chat updates by itself as you write to the graph, and the user can approve, discard or comment on "
    "proposals there. Replies are shown as plain text: no markdown headings or tables, a line or two each.")


def _options(resume: str | None, model: str | None = None) -> ClaudeAgentOptions:
    return ClaudeAgentOptions(
        cwd=AGENT_DIR,
        setting_sources=["project"],      # agent/CLAUDE.md
        skills=_app_skills(),             # agent/.claude/skills
        system_prompt={"type": "preset", "preset": "claude_code", "append": WEB_CHAT},
        mcp_servers={"backtrace": {"type": "http", "url": MCP_URL}},
        strict_mcp_config=True,           # ignore agent/.mcp.json (that one is for terminal sessions on the host)
        tools=["Skill"],                  # no file or shell tools: the graph is the only state
        allowed_tools=["mcp__backtrace"],
        permission_mode="dontAsk",        # anything not allowed above is denied, never prompted
        model=model or MODEL,
        max_turns=MAX_TURNS,
        resume=resume,
    )


def _prompt(message: str, view_id: str | None, intent_id: str | None) -> str:
    open_now = [f"view {view_id}" if view_id else "", f"intent {intent_id}" if intent_id else ""]
    open_now = [x for x in open_now if x]
    return f"{message}\n\n(Web UI: the user has {' and '.join(open_now)} open.)" if open_now else message


def _label(b: ToolUseBlock) -> str:
    inp = b.input or {}
    if b.name == "Skill":
        return f"skill · {inp.get('skill', '')}"
    name = b.name.removeprefix("mcp__backtrace__")
    detail = next((str(inp[k]) for k in ("name", "decision", "text", "view_id", "rid") if inp.get(k)), "")
    return f"{name} · {detail[:80]}" if detail else name


def _text(content) -> str:
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict))
    return str(content or "")


def _events(msg) -> list[dict]:
    if isinstance(msg, SystemMessage) and msg.subtype == "init":
        out = [{"type": "session", "session_id": msg.data.get("session_id")}]
        status = {s.get("name"): s.get("status") for s in msg.data.get("mcp_servers", [])}
        if status.get("backtrace") != "connected":
            out.append({"type": "error", "message": f"backtrace MCP server: {status.get('backtrace', 'missing')}"})
        return out
    if isinstance(msg, AssistantMessage) and msg.parent_tool_use_id is None:
        out = [{"type": "error", "message": f"model error: {msg.error}"}] if msg.error else []
        for b in msg.content:
            if isinstance(b, TextBlock) and b.text.strip():
                out.append({"type": "text", "text": b.text.strip()})
            elif isinstance(b, ToolUseBlock):
                out.append({"type": "tool", "label": _label(b)})
        return out
    if isinstance(msg, UserMessage) and isinstance(msg.content, list):
        return [{"type": "tool_error", "text": _text(b.content)[:300]}
                for b in msg.content if isinstance(b, ToolResultBlock) and b.is_error]
    if isinstance(msg, ResultMessage):
        return [{"type": "done", "session_id": msg.session_id, "is_error": msg.is_error, "turns": msg.num_turns,
                 "cost_usd": msg.total_cost_usd, "errors": msg.errors}]
    return []


def _sse(ev: dict) -> str:
    return f"data: {json.dumps(ev, default=str)}\n\n"


async def stream(message: str, session_id: str | None, view_id: str | None, intent_id: str | None,
                 is_disconnected: Callable[[], Awaitable[bool]], model: str | None = None) -> AsyncIterator[str]:
    """Run the agent in a background task and relay its events. If the browser goes away (Stop, closed tab),
    cancel the run right away, which also ends the Claude Code subprocess, instead of at the agent's next event."""
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    # Cancel through anyio, not task.cancel(): the SDK's cleanup only survives anyio-originated cancellation,
    # and a raw asyncio cancel leaves the CLI process running.
    scope = anyio.CancelScope()

    async def produce():
        try:
            with scope:
                async for ev in _run(_prompt(message, view_id, intent_id), session_id, model):
                    await queue.put(ev)
        finally:
            queue.put_nowait(None)

    task = asyncio.create_task(produce())
    _RUNS.add(task)  # keep a reference until the SDK has finished cleaning up
    task.add_done_callback(_RUNS.discard)
    try:
        while True:
            try:
                ev = await asyncio.wait_for(queue.get(), timeout=1.0)
            except TimeoutError:
                if await is_disconnected():
                    return
                continue
            if ev is None:
                return
            yield ev
    finally:
        scope.cancel()


async def _run(prompt: str, session_id: str | None, model: str | None = None) -> AsyncIterator[str]:
    async for ev in events(prompt, session_id, model):
        yield _sse(ev)


async def events(prompt: str, session_id: str | None, model: str | None = None) -> AsyncIterator[dict]:
    """The agent's events as dicts (see the module docstring). Also used by the research-thread worker.
    Sessions live in the container's ~/.claude, so a resume fails after the api container is recreated:
    in that case start a new conversation instead."""
    for resume in ([session_id, None] if session_id else [None]):
        started = False
        try:
            # aclosing: `async for` doesn't close the SDK's generator when the body raises, which skips its cleanup
            async with contextlib.aclosing(query(prompt=prompt, options=_options(resume, model))) as messages:
                async for msg in messages:
                    for ev in _events(msg):
                        if ev["type"] in ("text", "tool"):
                            started = True
                        elif ev["type"] == "done" and ev["is_error"] and not started and resume:
                            raise RuntimeError("; ".join(ev["errors"] or []) or "resume failed")
                        yield ev
            return
        except Exception as e:  # noqa: BLE001
            if started or not resume:
                yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
                return
            yield {"type": "note", "text": "the previous chat has expired, so this starts a new one"}
