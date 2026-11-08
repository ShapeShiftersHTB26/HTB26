"""FastAPI app: exposes the ops registry as REST (/api/op/<name>) and MCP (/mcp/)."""
import asyncio
import contextlib
import functools
import traceback

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from mcp.server.fastmcp import FastMCP

from . import graph, markets, notebook, ops, pg, thread  # noqa: F401  (imports register operations)
from . import worker as thread_worker
from .registry import REGISTRY, REST_ONLY


def _in_thread(fn):
    """FastMCP calls sync tools on the event loop, so a slow op (evaluate, agentic transforms) would freeze the
    whole api: the web chat stream and the UI's polling. Run them in the threadpool, like the REST route does.
    functools.wraps keeps the signature, so the tool schemas are unchanged."""
    @functools.wraps(fn)
    async def run(**kwargs):
        return await run_in_threadpool(fn, **kwargs)
    return run


mcp = FastMCP("backtrace", stateless_http=True, streamable_http_path="/")
for name, fn in REGISTRY.items():
    if name in REST_ONLY:
        continue
    mcp.add_tool(_in_thread(fn), name=name, description=(fn.__doc__ or "").strip())


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):
    await run_in_threadpool(graph.wait_until_ready)
    await run_in_threadpool(graph.ensure_indexes)
    try:
        await run_in_threadpool(pg.ensure_schema)
    except Exception as e:  # noqa: BLE001  (api still starts; ping reports postgres down)
        print(f"postgres not ready: {e}")
    worker = asyncio.create_task(thread_worker.loop()) if thread_worker.ENABLED else None
    settler = asyncio.create_task(markets.loop()) if markets.ENABLED else None  # data-settled markets past their end
    async with mcp.session_manager.run():
        yield
    for task in (worker, settler):
        if task:
            task.cancel()


app = FastAPI(title="backtrace", lifespan=lifespan)
app.mount("/mcp", mcp.streamable_http_app())


@app.get("/api/ops")
def list_ops() -> dict:
    return {"ops": sorted(REGISTRY)}


@app.post("/api/chat")
async def chat(request: Request, body: dict = Body(...)):
    """Web chat with the app agent, streamed as SSE (see chat.py). Body: {message, session_id?, view_id?, intent_id?}."""
    message = (body.get("message") or "").strip()
    if not message:
        raise HTTPException(400, "message is required")
    try:
        from . import chat as agent_chat  # lazy: the rest of the api keeps working on an image built before chat
    except ImportError as e:
        raise HTTPException(503, f"chat needs claude-agent-sdk; rebuild the api image ({e})") from e
    return StreamingResponse(
        agent_chat.stream(message, body.get("session_id"), body.get("view_id"), body.get("intent_id"),
                          request.is_disconnected),
        media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/op/{name}")
async def run_op(name: str, body: dict = Body(default_factory=dict)):
    fn = REGISTRY.get(name)
    if fn is None:
        raise HTTPException(404, f"unknown op '{name}'")
    try:
        return await run_in_threadpool(fn, **body)
    except TypeError as e:
        raise HTTPException(400, f"bad arguments for '{name}': {e}") from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}") from e
