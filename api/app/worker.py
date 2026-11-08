"""Research-thread worker: serves queued threads (thread.ask) with the app agent, inside the api.

Same agent as the web chat (chat.events: Claude Agent SDK, cwd agent/, backtrace MCP tools only), but the
conversation lives on the graph: the agent's final text becomes the thread's reply message, and each tool call
is shown live as the thread's `agent_activity`. One turn at a time. Off with BACKTRACE_THREAD_WORKER=off
(then scripts/runner.py on the host can serve threads instead)."""
import asyncio
import os
import traceback

from fastapi.concurrency import run_in_threadpool

from . import graph as g
from . import thread as T

ENABLED = os.environ.get("BACKTRACE_THREAD_WORKER", "on").lower() not in ("off", "0", "false", "no")
IDLE_S = 1.5


async def serve(t: dict) -> None:
    from . import chat  # lazy: needs claude-agent-sdk in the image
    texts, session_id, error = [], t.get("session_id"), None
    async for ev in chat.events(t["prompt"], t.get("session_id"), t.get("model")):
        kind = ev["type"]
        if kind == "session":
            session_id = ev.get("session_id") or session_id
        elif kind == "text":
            texts.append(ev["text"])
        elif kind == "tool":
            await run_in_threadpool(g.run, "MATCH (q:Intent {id:$q}) SET q.agent_activity = $a",
                                    q=t["intent_id"], a=ev["label"])
        elif kind == "done":
            session_id = ev.get("session_id") or session_id
            if ev.get("is_error"):
                error = "; ".join(ev.get("errors") or []) or "the agent stopped with an error"
        elif kind == "error":
            error = ev["message"]
    await run_in_threadpool(T.finish_turn, intent_id=t["intent_id"], reply=texts[-1] if texts else None,
                            session_id=session_id, error=None if texts and not error else error,
                            started_at=t["started_at"])


async def loop() -> None:
    first = True
    while True:
        try:
            t = await run_in_threadpool(T.next_turn, reset=first)
            first = False
            if not t.get("intent_id"):
                await asyncio.sleep(IDLE_S)
                continue
            try:
                await serve(t)
            except Exception as e:  # noqa: BLE001  (report to the thread, keep serving)
                traceback.print_exc()
                await run_in_threadpool(T.finish_turn, intent_id=t["intent_id"], error=f"{type(e).__name__}: {e}",
                                        started_at=t["started_at"])
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001  (graph not ready yet, etc.)
            traceback.print_exc()
            await asyncio.sleep(5)
